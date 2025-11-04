/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025 Bjoern Boss Henrichsen */
class SyncSocket {
	constructor(path) {
		this._ws = null;

		/* connection failed to be established or invalid session and reconnection will not be tried */
		this.onfailed = null;

		/* data have been received */
		this.onreceived = null;

		/* executed once the connection has been established */
		this.onconnected = null;

		/* queued callbacks to send to the remote */
		this._queued = [];

		/* delay before trying to restart the connection again */
		this._delay = 0;

		/* has the connection already existed */
		this._wasConnected = false;

		/*
		*	connecting: currently trying to establish connection
		*	ready: connection ready and able to receive response
		*	failed: failed and not retrying
		*/
		this._state = 'connecting';

		/* construct the url for the web-socket */
		let protocol = (location.protocol == 'https:' ? 'wss' : 'ws');
		this._url = `${protocol}://${location.host}${path}`;

		/* try to establish the first connection */
		this._resetTimeout();
		this._establish();
	}

	/* check if the socket is connected */
	connected() {
		return (this._state == 'ready');
	}

	/* check if the socket is being connected */
	connecting() {
		return (this._state != 'failed');
	}

	/* queue the callback to be invoked to send data */
	send(callback) {
		this._queued.push(callback);
		this._handleQueue();
	}

	/* retry to establish a connection */
	retry() {
		if (this._state == 'failed') {
			this._resetTimeout();
			this._establish();
		}
	}

	/* kill a current connection and prevent retrying to connect and log the error */
	error(msg) {
		if (this._state != 'failed') {
			console.log(`Connection to [${this._url}] manually failed: ${msg}`);
			this._fatal(msg);
		}
	}

	_resetTimeout() {
		this._delay = 128;
	}
	_handleQueue() {
		/* check if a connection is valid */
		if (this._state != 'ready' || this._queued.length == 0)
			return;
		console.log(`Uploading data to [${this._url}]...`);

		/* handle the queue content */
		while (this._queued.length > 0) {
			let callback = this._queued[0];
			this._queued.splice(0, 1);

			/* send the data and check if the connection has failed, in which case no further data are sent */
			callback((data) => this._ws.send(JSON.stringify(data)));
			if (this._state != 'ready')
				break;
		}
	}
	_establish() {
		console.log(`Trying to connect to [${this._url}]...`);
		this._state = 'connecting';

		/* try to create the socket */
		try {
			this._ws = new WebSocket(this._url);
		} catch (e) {
			console.error(`Error while creating socket to [${this._url}]: ${e}`);
			this._failed(false);
		}

		/* register all callbacks to the socket */
		let that = this;
		this._ws.onmessage = (m) => this._received(m);
		this._ws.onclose = function () {
			console.error(`Connection to remote lost [${that._url}]`);
			that._failed(true);
		};
		this._ws.onopen = function () {
			console.log(`Connection established to [${that._url}]`);
			that._state = 'ready';
			that._wasConnected = true;
			that._resetTimeout();

			/* clear the old queue and notify the client about the established connection */
			that._queued = [];
			if (that.onconnected != null)
				that.onconnected();

			/* handle the queue */
			that._handleQueue();
		};
		this._ws.onerror = () => this._failed(false);
	}
	_failed(fastRetry) {
		this._killSocket();

		/* check if another attempt should be made immediately */
		if (fastRetry) {
			this._establish();
			return;
		}

		/* check if this was the final try or if another try should be queued */
		if (this._state == 'failed')
			return;
		if (this._delay <= 512) {
			this._state = 'connecting';
			setTimeout(() => this._establish(), this._delay);
			this._delay *= 2;
			return;
		}

		/* mark the socket as failed */
		console.error(`Not trying a new connection to [${this._url}]`);
		if (this._wasConnected)
			this._fatal('Connection to server lost!');
		else
			this._fatal('Unable to establish a connection to the server!');
	}
	_killSocket() {
		let ws = this._ws;
		this._ws = null;
		if (ws == null)
			return;

		/* unbind all callbacks */
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		if (ws.readyState == WebSocket.OPEN)
			try { ws.close(); } catch (_) { }
		else {
			ws.onopen = function () {
				try { ws.close(); } catch (_) { }
			};
		}
	}
	_fatal(msg) {
		this._killSocket();
		this._state = 'failed';
		this._wasConnected = false;
		if (this.onfailed != null)
			this.onfailed(msg);
	}
	_received(m) {
		try {
			console.log(`Received data from [${this._url}]`);

			/* parse the message and handle it */
			let msg = JSON.parse(m.data);
			try {
				if (this.onreceived != null)
					this.onreceived(msg);
			}
			catch (e) {
				console.error(`User data handling error: ${e.message}`);
				this._fatal('Error while processing received data!');
			}
		} catch (e) {
			console.error(`Error while handling data from [${this._url}]: ${e.message}`);
			this._failed(true);
		}
	}
};
