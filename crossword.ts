/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025 Bjoern Boss Henrichsen */
import * as libCommon from "core/common.js";
import * as libClient from "core/client.js";
import * as libLog from "core/log.js";
import * as libLocation from "core/location.js";
import * as libFs from "fs";
import * as libWs from "ws";

const nameRegex = '[a-zA-Z0-9]([-_.]?[a-zA-Z0-9])*';
const nameMaxLength = 255;
const maxFileSize = 1_000_000;
const pingTimeout = 60_000;
const writeBackDelay = 20_000;

interface GridCell {
	solid: boolean;
	char: string;
	certain: boolean;
	author: string;
	time: number;
};
interface GameBoard {
	width: number;
	height: number;
	grid: GridCell[];
};
interface GameState extends GameBoard {
	failed: boolean;
	names: string[];
	online: string[];
};

class ActiveGame {
	private ws: Map<libWs.WebSocket, string>;
	private data: GameBoard | null;
	private filePath: string;
	private writebackFailed: boolean;
	private queued: NodeJS.Timeout | null;

	constructor(filePath: string) {
		this.ws = new Map<libWs.WebSocket, string>();
		this.data = null;
		this.filePath = filePath;
		this.writebackFailed = false;
		this.queued = null;

		/* fetch the initial data */
		try {
			const file = libFs.readFileSync(this.filePath, { encoding: 'utf-8', flag: 'r' });
			this.data = JSON.parse(file);
		}
		catch (e: any) {
			libLog.Error(`Failed to read the current game state: ${e.message}`);
		}
	}

	private buildOutput(): GameState {
		if (this.data == null)
			return { failed: false, grid: [], width: 0, height: 0, names: [], online: [] };
		let out: GameState = {
			failed: this.writebackFailed,
			grid: this.data.grid,
			width: this.data.width,
			height: this.data.height,
			names: [],
			online: []
		};

		/* collect the online names */
		let online: Set<string> = new Set<string>();
		let names: Set<string> = new Set<string>();
		for (const child of this.ws) {
			const name = child[1];
			if (name == '') continue;

			/* add the name to the list of objects */
			if (!online.has(name)) {
				online.add(name);
				out.online.push(name);
			}
			if (!names.has(name)) {
				names.add(name);
				out.names.push(name);
			}
		}

		/* collect all already used names in the grid */
		for (let i = 0; i < this.data.grid.length; ++i) {
			if (names.has(this.data.grid[i].author) || this.data.grid[i].author == '') continue;
			names.add(this.data.grid[i].author);
			out.names.push(this.data.grid[i].author);
		}
		return out;
	}
	private notifyAll(): void {
		const json = JSON.stringify(this.buildOutput());

		/* send the data to all clients */
		for (const child of this.ws)
			child[0].send(json);
	}
	private notifySingleId(ws: libWs.WebSocket): void {
		const json = JSON.stringify(this.buildOutput());
		ws.send(json);
	}
	private queueWriteBack(): void {
		if (this.data == null) return;

		/* kill the last queue */
		if (this.queued != null)
			clearTimeout(this.queued);
		this.queued = setTimeout(() => this.writeBack(false), writeBackDelay);
	}
	private writeBack(final: boolean): void {
		/* check if the data are dirty */
		if (this.queued == null) return;
		clearTimeout(this.queued);
		this.queued = null;

		const tempPath = `${this.filePath}.upload`;
		let written = false;
		try {
			/* try to write the data back to a temporary file */
			libLog.Log(`Creating temporary file [${tempPath}] for [${this.filePath}]`);
			libFs.writeFileSync(tempPath, JSON.stringify(this.data), { encoding: 'utf-8', flag: 'wx' });
			written = true;

			/* replace the existing file */
			libLog.Log(`Replacing file [${this.filePath}]`);
			libFs.renameSync(tempPath, this.filePath);
			this.writebackFailed = false;
			return;
		}
		catch (e: any) {
			if (written)
				libLog.Error(`Failed to replace original file [${this.filePath}]: ${e.message}`);
			else
				libLog.Error(`Failed to write to temporary file [${tempPath}]: ${e.message}`);
		}

		/* remove the temporary file */
		try {
			libFs.unlinkSync(tempPath);
		}
		catch (e: any) {
			libLog.Error(`Failed to remove temporary file [${tempPath}]: ${e.message}`);
		}

		/* check if the changes should be discarded */
		if (final)
			libLog.Warning(`Discarding write-back as state is lost`);
		else
			this.queueWriteBack();

		/* notify about the failed write-back */
		if (!this.writebackFailed)
			this.notifyAll();
		this.writebackFailed = true;
	}

	public updateGrid(client: libClient.HttpUpgrade, ws: libWs.WebSocket, grid: any): void {
		/* ensure that a grid exists */
		if (this.data == null) {
			client.log(`Discarding grid update for failed load [${this.filePath}]`);
			this.notifySingle(ws);
			return;
		}

		/* ensure that the player has a name */
		if (this.ws.get(ws)!.length == 0) {
			client.log(`Discarding grid update of unnamed player [${this.filePath}]`);
			this.notifySingle(ws);
			return;
		}

		/* validate the grid structure */
		let dirty = false, valid = (this.data.grid.length == grid.length);
		let merged: GridCell[] = [];
		for (let i = 0; i < grid.length && valid; ++i) {
			/* validate the data-types */
			if (typeof grid[i].char != 'string' || typeof grid[i].certain != 'boolean' || typeof grid[i].author != 'string' || typeof grid[i].time != 'number') {
				valid = false;
				break;
			}

			/* check if the grid is not newer than the current grid */
			if (grid[i].time <= this.data.grid[i].time) {
				merged.push(this.data.grid[i]);
				continue;
			}

			/* setup the sanitized data */
			let char = grid[i].char.slice(0, 1).toUpperCase();
			let certain = grid[i].certain;
			let author = grid[i].author.slice(0, nameMaxLength + 1);
			if (this.data.grid[i].solid) {
				char = '';
				author = '';
				certain = false;
			}
			else if (char == '' || char < 'A' || char > 'Z') {
				char = '';
				author = '';
				certain = false;
			}
			else if (char == this.data.grid[i].char)
				author = this.data.grid[i].author;

			/* check if the data actually have changed */
			if (char == this.data.grid[i].char && certain == this.data.grid[i].certain && author == this.data.grid[i].author) {
				merged.push(this.data.grid[i]);
				continue;
			}

			/* update the merged grid */
			merged.push({
				solid: this.data.grid[i].solid,
				char: char,
				certain: certain,
				author: author,
				time: grid[i].time
			});
			dirty = true;
		}

		/* check if the grid data are valid and otherwise notify the user */
		if (!valid) {
			client.error(`Discarding invalid grid update [${this.filePath}]`);
			this.notifySingle(ws);
			return;
		}

		/* check if the data are not dirty */
		if (!dirty) {
			client.log(`Discarding empty grid update of [${this.filePath}]`);
			this.notifySingle(ws);
			return;
		}

		/* update the grid and notify the listeners about the change */
		this.data.grid = merged;
		this.notifyAll();
		this.queueWriteBack();
	}
	public updateName(ws: libWs.WebSocket, name: string): void {
		name = name.slice(0, nameMaxLength + 1);
		if (this.ws.get(ws) == name) return;

		/* update the name and notify the other sockets */
		this.ws.set(ws, name);
		this.notifyAll();
	}
	public drop(ws: libWs.WebSocket): boolean {
		/* remove the web-socket from the open connections */
		let name = this.ws.get(ws)!;
		this.ws.delete(ws);

		/* check if this was the last listener and the object can be unloaded */
		if (this.ws.size == 0) {
			this.writeBack(true);
			return false;
		}

		/* check if other listeners should be notified */
		if (name.length > 0)
			this.notifyAll();
		return true;
	}
	public register(ws: libWs.WebSocket): void {
		this.ws.set(ws, '');
	}
	public notifySingle(ws: libWs.WebSocket): void {
		this.notifySingleId(ws);
	}
};

export class Crossword implements libCommon.ModuleInterface {
	private fileStatic: (path: string) => string;
	private fileGames: (path: string) => string;
	private gameStates: Record<string, ActiveGame>;

	public name: string = 'crossword';
	constructor(dataPath: string) {
		this.fileStatic = libLocation.MakeSelfPath(import.meta.url, '/static');
		this.fileGames = libLocation.MakeLocation(dataPath);
		this.gameStates = {};
	}

	private parseAndValidateGame(data: string): GameBoard {
		/* parse the json content */
		let obj = null;
		try {
			obj = JSON.parse(data);
		}
		catch (e) {
			throw new Error('Malformed JSON encountered');
		}

		/* validate the overall structure */
		if (typeof obj != 'object')
			throw new Error('Malformed object');
		if (typeof obj.width != 'number' || typeof obj.height != 'number'
			|| !isFinite(obj.width) || obj.width <= 0 || obj.width > 64
			|| !isFinite(obj.height) || obj.height <= 0 || obj.height > 64)
			throw new Error('Malformed Dimensions');

		/* validate the grid */
		if (obj.grid.length !== obj.width * obj.height)
			throw new Error('Malformed Grid');
		for (let i = 0; i < obj.width * obj.height; ++i) {
			if (typeof obj.grid[i] != 'boolean')
				throw new Error('Malformed Grid');
		}
		const out: GameBoard = {
			width: obj.width,
			height: obj.height,
			grid: []
		};

		/* construct the final initial gameboard */
		for (let i = 0; i < obj.grid.length; ++i) {
			out.grid.push({
				solid: obj.grid[i],
				char: '',
				certain: false,
				author: '',
				time: 0
			});
		}
		return out;
	}
	private modifyGame(client: libClient.HttpRequest): void {
		/* validate the method */
		const method = client.ensureMethod(['POST', 'DELETE']);
		if (method == null)
			return;

		/* extract the name */
		let name = client.path.slice(6);
		if (!name.match(nameRegex) || name.length > nameMaxLength) {
			client.respondNotFound();
			return;
		}
		client.log(`Handling Game: [${name}] as [${method}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game is being removed */
		if (method == 'DELETE') {
			if (!libFs.existsSync(filePath))
				client.respondNotFound();
			else try {
				libFs.unlinkSync(filePath);
				libLog.Log(`Game file: [${filePath}] deleted successfully`);
				client.respondOk('delete');
			} catch (e: any) {
				libLog.Error(`Error while removing file [${filePath}]: ${e.message}`);
				client.respondInternalError('File-System error removing the game');
			}
			return;
		}

		/* a game must be uploaded */
		if (libFs.existsSync(filePath)) {
			client.respondConflict('already exists');
			return;
		}

		/* validate the content type */
		if (client.ensureMediaType(['application/json']) == null)
			return;

		/* collect all of the data */
		let that = this;
		client.receiveAllText(maxFileSize, client.getMediaTypeCharset('utf-8'), function (text, err) {
			/* check if an error occurred */
			if (err) {
				client.error(`Error occurred while posting to [${filePath}]: ${err.message}`);
				client.respondInternalError('Network issue regarding the post payload');
				return;
			}

			/* parse the data */
			let parsed = null;
			try {
				parsed = that.parseAndValidateGame(text!);
			} catch (e: any) {
				client.error(`Error while parsing the game: ${e.message}`);
				client.respondBadRequest(e.message);
				return;
			}

			/* serialize the data to the file and write it out */
			try {
				libFs.writeFileSync(filePath, JSON.stringify(parsed), { encoding: 'utf-8', flag: 'wx' });
			}
			catch (e: any) {
				libLog.Error(`Error while writing the game out: ${e.message}`);
				client.respondInternalError('File-System error storing the game');
				return;
			}

			/* validate the post content */
			client.respondOk('upload');
		});
	}
	private queryGames(client: libClient.HttpRequest): void {
		let content: string[] = [];
		try {
			content = libFs.readdirSync(this.fileGames('.'));
		}
		catch (e: any) {
			libLog.Error(`Error while reading directory content: ${e.message}`);
		}
		let out = [];

		/* collect them all out */
		libLog.Log(`Querying list of all registered games: [${content}]`);
		for (const name of content) {
			if (!name.endsWith('.json'))
				continue;
			let actual = name.slice(0, name.length - 5);
			if (!actual.match(nameRegex) || actual.length > nameMaxLength)
				continue;
			out.push(name.slice(0, name.length - 5));
		}

		/* return them to the request */
		client.respondJson(JSON.stringify(out));
	}
	private acceptWebSocket(client: libClient.HttpUpgrade, ws: libWs.WebSocket, name: string): void {
		client.log(`Handling WebSocket to: [${name}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game exists */
		if (!libFs.existsSync(filePath)) {
			ws.send(JSON.stringify('unknown-game'));
			ws.close();
			return;
		}

		/* check if the game-state for the given name has already been set-up */
		if (!(name in this.gameStates))
			this.gameStates[name] = new ActiveGame(filePath);
		this.gameStates[name].register(ws);
		client.log(`Registered websocket to [${name}]`);

		/* define the alive callback */
		let isAlive = true, aliveInterval: NodeJS.Timeout | null = null;
		const queueAliveCheck = function (alive: boolean): void {
			/* update the alive-flag and kill the old timer */
			isAlive = alive;
			if (aliveInterval != null)
				clearTimeout(aliveInterval);

			/* queue the check callback */
			aliveInterval = setTimeout(function () {
				if (!isAlive) {
					ws.close();
					aliveInterval = null;
				}
				else {
					queueAliveCheck(false);
					ws.ping();
				}
			}, pingTimeout);
		};

		/* initiate the alive-check */
		queueAliveCheck(true);

		/* register the web-socket callbacks */
		let that = this;
		ws.on('pong', () => queueAliveCheck(true));
		ws.on('close', function () {
			if (!that.gameStates[name].drop(ws))
				delete that.gameStates[name];
			if (aliveInterval != null)
				clearTimeout(aliveInterval);
			client.log(`Socket disconnected`);
		});
		ws.on('message', function (data) {
			queueAliveCheck(true);

			/* parse the data */
			try {
				let parsed = JSON.parse(data.toString('utf-8'));
				client.log(`Received for socket: ${parsed.cmd}`);

				/* handle the command */
				if (parsed.cmd == 'name' && typeof parsed.name == 'string')
					that.gameStates[name].updateName(ws, parsed.name);
				else if (parsed.cmd == 'update')
					that.gameStates[name].updateGrid(client, ws, parsed.data);
			} catch (e: any) {
				client.error(`Failed to parse web-socket response: ${e.message}`);
				ws.close();
			}
		});

		/* send the initial state to the socket */
		this.gameStates[name].notifySingle(ws);
	}

	public request(client: libClient.HttpRequest): void {
		client.log(`Game handler for [${client.path}]`);

		/* check if a game is being manipulated */
		if (client.path.startsWith('/game/')) {
			this.modifyGame(client);
			return;
		}

		/* all other endpoints only support 'getting' */
		if (client.ensureMethod(['GET']) == null)
			return;

		/* check if its a redirection and forward it accordingly */
		if (client.path == '/' || client.path == '/main') {
			client.tryRespondFile(this.fileStatic('main.html'));
			return;
		}
		if (client.path == '/editor') {
			client.tryRespondFile(this.fileStatic('editor.html'));
			return;
		}
		if (client.path == '/play') {
			client.tryRespondFile(this.fileStatic('play.html'));
			return;
		}

		/* check if the games are queried */
		if (client.path == '/games') {
			this.queryGames(client);
			return;
		}

		/* respond to the request by trying to server the file */
		client.tryRespondFile(this.fileStatic(client.path));
	}
	public upgrade(client: libClient.HttpUpgrade): void {
		client.log(`Game handler for [${client.path}]`);

		/* check if a web-socket is connecting */
		if (!client.path.startsWith('/ws/')) {
			client.respondNotFound();
			return;
		}

		/* extract the name and validate it */
		let name = client.path.slice(4);
		if (name.match(nameRegex) && name.length <= nameMaxLength) {
			if (client.tryAcceptWebSocket((ws) => this.acceptWebSocket(client, ws, name)))
				return;
		}
		client.log(`Invalid request for web-socket point for game [${name}]`);
		client.respondNotFound();
	}
};
