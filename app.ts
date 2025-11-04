/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025 Bjoern Boss Henrichsen */
import * as libLog from "../../server/log.js";
import * as libFs from "fs";
import * as libLocation from "../../server/location.js";

const fileStatic = libLocation.makeAppPath(import.meta.url, 'static');
const fileStorage = libLocation.makeStoragePath('crossword');

let gameState = {};

const nameRegex = '[a-zA-Z0-9]([-_.]?[a-zA-Z0-9])*';
const nameMaxLength = 255;
const maxFileSize = 1_000_000;
const pingTimeout = 60_000;
const writeBackDelay = 20_000;

class ActiveGame {
	constructor(name, filePath) {
		this.ws = {};
		this.data = null;
		this.name = name;
		this.filePath = filePath;
		this.queued = null;
		this.writebackFailed = false;
		this.nextId = 0;

		/* fetch the initial data */
		try {
			const file = libFs.readFileSync(this.filePath, { encoding: 'utf-8', flag: 'r' });
			this.data = JSON.parse(file);
		}
		catch (e) {
			libLog.Error(`Failed to read the current game state: ${e.message}`);
		}
	}

	_buildOutput() {
		let out = {
			failed: this.writebackFailed,
			grid: this.data.grid,
			width: this.data.width,
			height: this.data.height,
			names: [],
			online: []
		};

		/* collect the online names */
		let online = {}, names = {};
		for (const id in this.ws) {
			const name = this.ws[id].name;
			if (name == '') continue;

			/* add the name to the list of objects */
			if (!(name in online)) {
				online[name] = 1;
				out.online.push(name);
			}
			if (!(name in names)) {
				names[name] = 1;
				out.names.push(name);
			}
		}

		/* collect all already used names in the grid */
		if (this.data != null) {
			for (let i = 0; i < this.data.grid.length; ++i) {
				if (this.data.grid[i].author in names || this.data.grid[i].author == '') continue;
				names[this.data.grid[i].author] = true;
				out.names.push(this.data.grid[i].author);
			}
		}
		return out;
	}
	_notifyAll() {
		const json = JSON.stringify(this._buildOutput());

		/* send the data to all clients */
		for (const id in this.ws)
			this.ws[id].ws.send(json);
	}
	_notifySingle(id) {
		const json = JSON.stringify(this._buildOutput());
		this.ws[id].ws.send(json);
	}
	_queueWriteBack() {
		if (this.data == null) return;

		/* kill the last queue */
		if (this.queued != null)
			clearTimeout(this.queued);
		this.queued = setTimeout(() => this._writeBack(false), writeBackDelay);
	}
	_writeBack(final) {
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
		catch (e) {
			if (written)
				libLog.Error(`Failed to replace original file [${this.filePath}]: ${e.message}`);
			else
				libLog.Error(`Failed to write to temporary file [${tempPath}]: ${e.message}`);
		}

		/* remove the temporary file */
		try {
			libFs.unlinkSync(tempPath);
		}
		catch (e) {
			libLog.Error(`Failed to remove temporary file [${tempPath}]: ${e.message}`);
		}

		/* check if the changes should be discarded */
		if (final)
			libLog.Warning(`Discarding write-back as state is lost`);
		else
			this._queueWriteBack();

		/* notify about the failed write-back */
		if (!this.writebackFailed)
			this._notifyAll();
		this.writebackFailed = true;
	}
	updateGrid(id, grid) {
		let valid = (this.data != null && this.data.grid.length == grid.length);

		/* validate the grid structure */
		let merged = [], dirty = false;
		if (valid) {
			for (let i = 0; i < grid.length; ++i) {
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
		}

		/* check if the grid data are valid and otherwise notify the user */
		if (!valid) {
			libLog.Log(`Discarding invalid grid update [${this.filePath}]`);
			this._notifySingle(id);
			return;
		}

		/* check if the data are not dirty */
		if (!dirty) {
			libLog.Log(`Discarding empty grid update of [${this.filePath}]`);
			this._notifySingle(id);
			return;
		}

		/* update the grid and notify the listeners about the change */
		this.data.grid = merged;
		this._notifyAll();
		this._queueWriteBack();
	}
	updateName(id, name) {
		name = name.slice(0, nameMaxLength + 1);
		if (this.ws[id].name == name) return;

		/* update the name and notify the other sockets */
		this.ws[id].name = name;
		this._notifyAll();
	}
	drop(id) {
		/* remove the web-socket from the open connections */
		let name = this.ws[id].name;
		delete this.ws[id];

		/* check if this was the last listener and the object can be unloaded */
		if (Object.keys(this.ws) == 0) {
			this._writeBack(true);
			delete gameState[this.name];
			return;
		}

		/* check if other listeners should be notified */
		if (name.length > 0)
			this._notifyAll();
	}
	register(ws) {
		this.ws[++this.nextId] = { ws: ws, name: '' };
		return this.nextId;
	}
	notifySingle(id) {
		this._notifySingle(id);
	}
}

function ParseAndValidateGame(data) {
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
	try {
		if (obj.grid.length !== obj.width * obj.height)
			throw 'err';
		for (let i = 0; i < obj.width * obj.height; ++i) {
			if (typeof obj.grid[i] != 'boolean')
				throw 'err';
		}
	} catch (e) {
		throw new Error('Malformed Grid');
	}

	/* patch the object to contain all necessary meta data */
	for (let i = 0; i < obj.grid.length; ++i) {
		obj.grid[i] = {
			solid: obj.grid[i],
			char: '',
			certain: false,
			author: '',
			time: 0
		};
	}
	return obj;
}
function ModifyGame(msg) {
	/* validate the method */
	const method = msg.ensureMethod(['POST', 'DELETE']);
	if (method == null)
		return;

	/* extract the name */
	let name = msg.relative.slice(6);
	if (!name.match(nameRegex) || name.length > nameMaxLength) {
		msg.respondNotFound();
		return;
	}
	libLog.Log(`Handling Game: [${name}] as [${method}]`);
	const filePath = fileStorage(`${name}.json`);

	/* check if the game is being removed */
	if (method == 'DELETE') {
		if (!libFs.existsSync(filePath))
			msg.respondNotFound();
		else try {
			libFs.unlinkSync(filePath);
			libLog.Log(`Game file: [${filePath}] deleted successfully`);
			msg.respondOk('delete');
		} catch (e) {
			libLog.Error(`Error while removing file [${filePath}]: ${e.message}`);
			msg.respondInternalError('File-System error removing the game');
		}
		return;
	}

	/* a game must be uploaded */
	if (libFs.existsSync(filePath)) {
		msg.respondConflict('already exists');
		return;
	}

	/* validate the content type */
	if (msg.ensureMediaType(['application/json']) == null)
		return;

	/* validate the content length */
	if (!msg.ensureContentLength(maxFileSize))
		return;

	/* collect all of the data */
	msg.receiveAllText(msg.getMediaTypeCharset('utf-8'), function (text, err) {
		/* check if an error occurred */
		if (err) {
			libLog.Error(`Error occurred while posting to [${filePath}]: ${err.message}`);
			msg.respondInternalError('Network issue regarding the post payload');
			return;
		}

		/* parse the data */
		let parsed = null;
		try {
			parsed = ParseAndValidateGame(text);
		} catch (e) {
			libLog.Error(`Error while parsing the game: ${e.message}`);
			msg.respondBadRequest(e.message);
			return;
		}

		/* serialize the data to the file and write it out */
		try {
			libFs.writeFileSync(filePath, JSON.stringify(parsed), { encoding: 'utf-8', flag: 'wx' });
		}
		catch (e) {
			libLog.Error(`Error while writing the game out: ${e.message}`);
			msg.respondInternalError('File-System error storing the game');
			return;
		}

		/* validate the post content */
		msg.respondOk('upload');
	});
}
function QueryGames(msg) {
	let content = [];
	try {
		content = libFs.readdirSync(fileStorage('.'));
	}
	catch (e) {
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
	msg.respondJson(JSON.stringify(out));
}
function AcceptWebSocket(ws, name) {
	libLog.Log(`Handling WebSocket to: [${name}]`);
	const filePath = fileStorage(`${name}.json`);

	/* check if the game exists */
	if (!libFs.existsSync(filePath)) {
		ws.send(JSON.stringify('unknown-game'));
		ws.close();
		return;
	}

	/* check if the game-state for the given name has already been set-up */
	if (!(name in gameState))
		gameState[name] = new ActiveGame(name, filePath);
	const id = gameState[name].register(ws);
	libLog.Log(`Registered websocket to: [${name}] as [${id}]`);

	/* define the alive callback */
	let isAlive = true, aliveInterval = null, queueAliveCheck = null;
	queueAliveCheck = function (alive) {
		/* update the alive-flag and kill the old timer */
		isAlive = alive;
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
	ws.on('pong', () => queueAliveCheck(true));
	ws.on('close', function () {
		gameState[name].drop(id);
		clearTimeout(aliveInterval);
		libLog.Log(`Socket [${id}] disconnected`);
	});
	ws.on('message', function (data) {
		queueAliveCheck(true);

		/* parse the data */
		try {
			let parsed = JSON.parse(data);
			libLog.Log(`Received for socket [${id}]: ${parsed.cmd}`);

			/* handle the command */
			if (parsed.cmd == 'name' && typeof parsed.name == 'string')
				gameState[name].updateName(id, parsed.name);
			else if (parsed.cmd == 'update')
				gameState[name].updateGrid(id, parsed.data);
		} catch (e) {
			libLog.Error(`Failed to parse web-socket response: ${e.message}`);
			ws.close();
		}
	});

	/* send the initial state to the socket */
	gameState[name].notifySingle(id);
}

export class Application {
	constructor() {
		this.path = '/crossword';
	}

	request(msg) {
		libLog.Log(`Game handler for [${msg.relative}]`);

		/* check if a game is being manipulated */
		if (msg.relative.startsWith('/game/')) {
			ModifyGame(msg);
			return;
		}

		/* all other endpoints only support 'getting' */
		if (msg.ensureMethod(['GET']) == null)
			return;

		/* check if its a redirection and forward it accordingly */
		if (msg.relative == '/' || msg.relative == '/main') {
			msg.tryRespondFile(fileStatic('main.html'));
			return;
		}
		if (msg.relative == '/editor') {
			msg.tryRespondFile(fileStatic('editor.html'));
			return;
		}
		if (msg.relative == '/play') {
			msg.tryRespondFile(fileStatic('play.html'));
			return;
		}

		/* check if the games are queried */
		if (msg.relative == '/games') {
			QueryGames(msg);
			return;
		}

		/* respond to the request by trying to server the file */
		msg.tryRespondFile(fileStatic(msg.relative));
	}
	upgrade(msg) {
		libLog.Log(`Game handler for [${msg.relative}]`);

		/* check if a web-socket is connecting */
		if (!msg.relative.startsWith('/ws/')) {
			msg.respondNotFound();
			return;
		}

		/* extract the name and validate it */
		let name = msg.relative.slice(4);
		if (name.match(nameRegex) && name.length <= nameMaxLength) {
			if (msg.tryAcceptWebSocket((ws) => AcceptWebSocket(ws, name)))
				return;
		}
		libLog.Warning(`Invalid request for web-socket point for game [${name}]`);
		msg.respondNotFound();
	}
};
