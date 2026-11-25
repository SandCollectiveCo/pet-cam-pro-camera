// A stand-in for the Worker's realtime socket, inside one page: it passes
// each signal and command on with who sent it and the sealed part
// untouched, keeps each camera's latest status, keeps a still only for a
// while after someone asked that camera for one, and drops what the Worker
// drops, without a word (docs/API.md, Realtime). It reads nothing that's
// sealed, since it has no keys: the two ends of a test share a camera's own.

import { MAX_PEEK_BYTES, MAX_SEALED, isDeviceId, isSealed, isSession } from '../src/wire/frames.js';

/** How long after a command reached a camera its stills are kept. */
const PEEK_WINDOW_MS = 40_000;

export class Relay {
    constructor() {
        /** @type {Map<string, { onText: ((text: string) => void) | null }>} */
        this.links = new Map();
        /** Each camera's latest sealed status. @type {Map<string, { sealed: string }>} */
        this.statuses = new Map();
        /** The stills kept for each camera, sealed. @type {Map<string, Uint8Array[]>} */
        this.stills = new Map();
        /** Until when each camera's stills are kept. @type {Map<string, number>} */
        this.peeking = new Map();
        /** Every frame it dropped, as the Worker would have, with why. */
        this.dropped = [];
        /** Every frame it passed on, for a test to look at what crossed. */
        this.passed = [];
    }

    /**
     * A device's socket. @param {string} deviceId
     * @returns {import('../src/camera/link.js').Link}
     */
    join(deviceId) {
        const link = {
            isOpen: true,
            opened: 1,
            onText: null,
            onState: null,
            send: (text) => {
                this.take(deviceId, text);
                return true;
            },
            sendBinary: (bytes) => {
                this.takeBinary(deviceId, bytes);
                return true;
            },
        };
        this.links.set(deviceId, link);
        return link;
    }

    /** A device's socket closes. @param {string} deviceId */
    leave(deviceId) {
        this.links.delete(deviceId);
    }

    /** @param {string} to @param {Record<string, unknown>} frame */
    deliver(to, frame) {
        const text = JSON.stringify(frame);
        // As a network would: later, never inside the sender's own call.
        setTimeout(() => this.links.get(to)?.onText?.(text), 0);
    }

    /** @param {string} from @param {string} text */
    take(from, text) {
        let frame;
        try {
            frame = JSON.parse(text);
        } catch {
            return this.dropped.push({ from, why: 'not JSON' });
        }
        if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return this.dropped.push({ from, why: 'not an object' });
        if (frame.type === 'signal') {
            if (!isDeviceId(frame.to) || !isSession(frame.session) || !isSealed(frame.payload, MAX_SEALED.signal)) return this.dropped.push({ from, why: 'a signal the Worker drops', frame });
            if (!this.links.has(frame.to)) return this.deliver(from, { type: 'error', code: 'peer_offline', to: frame.to, session: frame.session });
            this.passed.push({ type: 'signal', from, to: frame.to, session: frame.session, chars: frame.payload.sealed.length });
            return this.deliver(frame.to, { type: 'signal', from, session: frame.session, payload: frame.payload });
        }
        if (frame.type === 'command') {
            if (!isDeviceId(frame.to) || !isSealed(frame.command, MAX_SEALED.command)) return this.dropped.push({ from, why: 'a command the Worker drops', frame });
            if (!this.links.has(frame.to)) return this.deliver(from, { type: 'error', code: 'peer_offline', to: frame.to, session: null });
            // A command from another device opens that camera's forty seconds.
            if (frame.to !== from) this.peeking.set(frame.to, Date.now() + PEEK_WINDOW_MS);
            this.passed.push({ type: 'command', from, to: frame.to });
            return this.deliver(frame.to, { type: 'command', from, command: frame.command });
        }
        if (frame.type === 'status') {
            if (!isSealed(frame.status, MAX_SEALED.status)) return this.dropped.push({ from, why: 'a status the Worker drops', frame });
            this.statuses.set(from, frame.status);
            this.passed.push({ type: 'status', from });
            return undefined;
        }
        return this.dropped.push({ from, why: 'a type the Worker takes from nobody', frame });
    }

    /** @param {string} from @param {Uint8Array} bytes */
    takeBinary(from, bytes) {
        if (bytes.length > MAX_PEEK_BYTES) return this.dropped.push({ from, why: 'a still too large' });
        if (bytes[0] !== 0x05) return this.dropped.push({ from, why: "a still that isn't sealed media" });
        if (!((this.peeking.get(from) ?? 0) > Date.now())) return this.dropped.push({ from, why: 'a still nobody asked for' });
        const kept = this.stills.get(from) ?? [];
        kept.push(Uint8Array.from(bytes));
        this.stills.set(from, kept);
        return undefined;
    }
}
