// What carries frames between this camera and the Worker (docs/API.md,
// Realtime): a socket that pings, notices when it has died without closing,
// and comes back by itself.
//
// How a socket is opened is not done here. A browser can't send the
// Authorization header on a WebSocket, so the Worker takes a one-use ticket
// in its place (docs/API.md, Temporary cameras, Its socket): asking for one
// and opening the socket by it is the door's (src/join/), and `open` below
// is where it comes in. Everything after a socket exists is here.

import { CLOSE, HEARTBEAT } from '../wire/frames.js';

/**
 * What the camera's signalling talks through. A test's stand-in passes
 * frames straight to another end in the same page.
 * @typedef {object} Link
 * @property {(text: string) => boolean} send false when nothing is open to send on
 * @property {(bytes: Uint8Array) => boolean} sendBinary
 * @property {((text: string) => void) | null} onText a text frame from the Worker, the heartbeat's aside
 * @property {((state: LinkState) => void) | null} onState
 * @property {boolean} isOpen
 * @property {number} opened how many times it has opened: a camera says how it is first thing on each new socket
 */

/** `open`: frames flow. `closed`: it's trying again by itself. `gone`: the
 * Worker says this device is no longer in the home, so the camera is over.
 * `replaced`: this camera opened a socket somewhere else (the page in a
 * second tab), and this one stands down rather than fight it.
 * @typedef {'open' | 'closed' | 'gone' | 'replaced'} LinkState */

/** What `open` throws when the Worker says the camera is no more. */
export class Gone extends Error {
    constructor() {
        super('this camera has ended');
        this.name = 'Gone';
    }
}

export class SocketLink {
    /**
     * @param {{
     *   open: () => Promise<WebSocket>,
     *   clock: { now: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void },
     *   random?: () => number,
     * }} options `open` gives a socket on its way to opening, and throws `Gone` when there's no camera to open one for
     */
    constructor(options) {
        this.options = options;
        this.random = options.random ?? Math.random;
        this.socket = null;
        this.wanted = false;
        this.isOpen = false;
        this.opened = 0;
        this.attempt = 0;
        this.lastHeard = 0;
        this.generation = 0;
        this.pingTimer = null;
        this.replyTimer = null;
        this.retryTimer = null;
        /** @type {((text: string) => void) | null} */
        this.onText = null;
        /** @type {((state: LinkState) => void) | null} */
        this.onState = null;
    }

    start() {
        if (this.wanted) return;
        this.wanted = true;
        this.connect();
    }

    /** Closes it for good: the camera stopped. */
    stop() {
        this.wanted = false;
        this.teardown();
        this.options.clock.clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    async connect() {
        if (!this.wanted || this.socket) return;
        const generation = ++this.generation;
        let socket;
        try {
            socket = await this.options.open();
        } catch (error) {
            if (generation !== this.generation || !this.wanted) return;
            if (error instanceof Gone) return this.over('gone');
            return this.retry();
        }
        if (generation !== this.generation || !this.wanted) {
            socket.close();
            return;
        }
        this.socket = socket;
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
            if (socket !== this.socket) return;
            this.isOpen = true;
            this.opened += 1;
            this.attempt = 0;
            this.lastHeard = this.options.clock.now();
            this.onState?.('open');
            this.schedulePing();
        };
        socket.onmessage = (event) => {
            if (socket !== this.socket) return;
            this.lastHeard = this.options.clock.now();
            if (typeof event.data === 'string' && event.data !== HEARTBEAT.pong) this.onText?.(event.data);
        };
        socket.onclose = (event) => {
            if (socket !== this.socket) return;
            this.teardown();
            if (event.code === CLOSE.gone) this.over('gone');
            else if (event.code === CLOSE.replaced) this.over('replaced');
            else {
                this.onState?.('closed');
                this.retry();
            }
        };
        socket.onerror = () => {
            // A close follows, and that's what's acted on.
        };
    }

    /** @param {'gone' | 'replaced'} state */
    over(state) {
        this.wanted = false;
        this.teardown();
        this.onState?.(state);
    }

    teardown() {
        this.generation += 1;
        this.options.clock.clearTimeout(this.pingTimer);
        this.options.clock.clearTimeout(this.replyTimer);
        this.pingTimer = null;
        this.replyTimer = null;
        const socket = this.socket;
        this.socket = null;
        this.isOpen = false;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            try {
                socket.close();
            } catch {
                // Already closed.
            }
        }
    }

    /** 1, 2, 4 … 30 seconds, with a little either way so a home's devices don't all come back at once. */
    retry() {
        if (!this.wanted || this.retryTimer !== null) return;
        this.attempt += 1;
        const seconds = Math.min(30, 2 ** Math.min(this.attempt - 1, 5)) * (0.8 + this.random() * 0.4);
        this.retryTimer = this.options.clock.setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, seconds * 1000);
    }

    schedulePing() {
        this.pingTimer = this.options.clock.setTimeout(() => this.ping(), HEARTBEAT.everyMs);
    }

    /** The Worker answers each ping. No answer in ten seconds means the
     * connection died without closing: reconnect, rather than wait the
     * minutes it would take to notice otherwise. */
    ping() {
        const socket = this.socket;
        if (!socket || !this.isOpen) return;
        const sent = this.options.clock.now();
        try {
            socket.send(HEARTBEAT.ping);
        } catch {
            // The check below finds out.
        }
        this.replyTimer = this.options.clock.setTimeout(() => {
            if (socket !== this.socket) return;
            if (this.lastHeard >= sent) return;
            this.teardown();
            this.onState?.('closed');
            this.retry();
        }, HEARTBEAT.replyWithinMs);
        this.schedulePing();
    }

    /** @param {string} text */
    send(text) {
        if (!this.socket || !this.isOpen) return false;
        try {
            this.socket.send(text);
            return true;
        } catch {
            return false;
        }
    }

    /** @param {Uint8Array} bytes */
    sendBinary(bytes) {
        if (!this.socket || !this.isOpen) return false;
        try {
            this.socket.send(bytes);
            return true;
        } catch {
            return false;
        }
    }
}
