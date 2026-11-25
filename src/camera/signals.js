// The camera's signalling: everything it says to the home and hears from it,
// sealed and signed with its own keys (docs/API.md, Sealed messages and
// Realtime; docs/WEB-CAMERA.md § 3).
//
// What comes in is opened only as what it claims to be (who sent it, for
// this camera, for that session), only under the current keys, and acted on
// only if it's fresh: a signal within two minutes of this clock, a command
// within two minutes and never twice. What doesn't open, or isn't fresh, is
// dropped without a word, as the apps drop it. An answer is applied only if
// its signature holds under the camera's signal key; an offer goes out
// signed.
//
// This is where the keys are used. The sessions themselves (src/rtc/) never
// see a key, and the Worker never sees anything unsealed.

import { SealContext } from '../crypto/keys.js';
import { packPeekFrame } from '../crypto/peek.js';
import { SeenCommands, readCommand } from '../wire/command.js';
import { MAX_PEEK_BYTES, readFrame, signalFrame, statusFrame } from '../wire/frames.js';
import { offerSignal, readSignal, signalIsFresh, watchTerms } from '../wire/signal.js';

export class CameraSignals {
    /**
     * @param {{
     *   keys: import('../crypto/keys.js').KeySet,
     *   cameraId: string,
     *   link: import('./link.js').Link,
     *   broadcaster: import('../rtc/broadcaster.js').CameraBroadcaster,
     *   now: () => number,
     *   seen?: SeenCommands,
     *   onCommand?: (from: string, command: import('../wire/command.js').Command['command']) => void,
     *   onSeen?: (kept: Record<string, number>) => void,
     *   onLimits?: (limits: import('../wire/frames.js').Limits | null) => void,
     *   onPlanRequired?: () => void,
     * }} options `onLimits`: the Worker said what the home's plan allows this camera now, null for nothing; `onPlanRequired`: it turned a signal of this camera's away for want of a plan
     */
    constructor(options) {
        this.keys = options.keys;
        this.cameraId = options.cameraId;
        this.link = options.link;
        this.broadcaster = options.broadcaster;
        this.now = options.now;
        this.seen = options.seen ?? new SeenCommands();
        this.onCommand = options.onCommand ?? null;
        this.onSeen = options.onSeen ?? null;
        this.onLimits = options.onLimits ?? null;
        this.onPlanRequired = options.onPlanRequired ?? null;
        /** Frames are handled one at a time, in the order they came. */
        this.queue = Promise.resolve();
        /** And signals go out in the order they were handed over: an offer before its candidates. */
        this.outgoing = Promise.resolve();
        this.link.onText = (text) => {
            this.queue = this.queue.then(() => this.receive(text)).catch(() => {});
        };
    }

    /** Everything queued so far has been handled. */
    settled() {
        return this.queue;
    }

    /** One text frame from the Worker. @param {string} text */
    async receive(text) {
        const frame = readFrame(text);
        if (!frame) return;
        if (frame.type === 'signal') await this.signal(/** @type {any} */ (frame));
        else if (frame.type === 'command') await this.command(/** @type {any} */ (frame));
        else if (frame.type === 'error') this.error(/** @type {any} */ (frame));
        // The one thing the Worker itself tells it: what its home's plan
        // allows it now. It isn't sealed, and it can't be: it's the Worker's
        // own word, about what the Worker itself will pass on.
        else if (frame.type === 'limits_changed') this.onLimits?.(/** @type {any} */ (frame).limits);
        // Nothing else is for a temporary camera: its socket carries no
        // presence, no events and no other device's row (docs/API.md,
        // Temporary cameras, Its socket), and it acts on none it's sent.
    }

    /** @param {{ from: string, session: string, payload: { sealed: string } }} frame */
    async signal(frame) {
        let opened;
        try {
            opened = await this.keys.openMessage(frame.payload, SealContext.signal(frame.from, this.cameraId, frame.session), { fresh: true });
        } catch {
            return;
        }
        const signal = readSignal(opened);
        if (!signal || !signalIsFresh(signal, this.now())) return;
        switch (signal.kind) {
            case 'watch':
                await this.broadcaster.watch(frame.from, frame.session, watchTerms(signal), signal.viewerName);
                break;
            case 'answer':
                if (signal.sdp === null) return;
                if (await this.keys.verify(`${frame.session}|answer|${signal.sdp}`, signal.sig)) await this.broadcaster.answer(frame.from, frame.session, signal.sdp);
                else if (this.broadcaster.peers.get(frame.session)?.viewer === frame.from) this.broadcaster.refuse(frame.session);
                break;
            case 'candidate':
                if (signal.candidate !== null) await this.broadcaster.candidate(frame.from, frame.session, { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex });
                break;
            case 'bye':
                this.broadcaster.bye(frame.from, frame.session);
                break;
            default:
                // Nothing acts on a kind it doesn't know.
                break;
        }
    }

    /** @param {{ from: string, command: { sealed: string } }} frame */
    async command(frame) {
        let opened;
        try {
            opened = await this.keys.openMessage(frame.command, SealContext.command(frame.from, this.cameraId), { fresh: true });
        } catch {
            return;
        }
        const command = readCommand(opened);
        if (!command || !this.seen.take(command, this.now())) return;
        this.onSeen?.(this.seen.kept());
        this.onCommand?.(frame.from, command.command);
    }

    /** The Worker didn't pass a signal on: its viewer isn't there
     * (`peer_offline`), or the home has no plan in force (`plan_required`).
     * Either way that session can't be set up, and telling its viewer so
     * would only come back the same way. A call already connected isn't
     * touched by a plan running out: only what was still being set up goes.
     * @param {{ code: string, to: string | null, session: string | null }} frame */
    error(frame) {
        if (frame.code !== 'peer_offline' && frame.code !== 'plan_required') return;
        if (frame.code === 'plan_required') this.onPlanRequired?.();
        if (frame.session === null) return;
        const peer = this.broadcaster.peers.get(frame.session);
        if (!peer || peer.viewer !== frame.to) return;
        if (frame.code === 'peer_offline' || !peer.hasConnected) this.broadcaster.end(frame.session, null, false);
    }

    // ---- Out ---------------------------------------------------------------

    /** What the broadcaster hands over to send: sealed for that viewer and
     * that session, an offer signed first.
     * @param {string} viewer @param {string} session @param {Record<string, unknown>} payload
     * @returns {Promise<boolean>} whether there was a socket to send it on */
    send(viewer, session, payload) {
        const sent = this.outgoing.then(() => this.sendNow(viewer, session, payload));
        this.outgoing = sent.catch(() => {});
        return sent;
    }

    /** Everything handed over so far has gone. */
    flushed() {
        return this.outgoing;
    }

    /** @param {string} viewer @param {string} session @param {Record<string, unknown>} payload */
    async sendNow(viewer, session, payload) {
        // `relay` is outside what an offer's signature covers: sealed with the rest, and only ever said as false.
        const signed = payload.kind === 'offer' ? offerSignal(/** @type {string} */ (payload.sdp), await this.keys.sign(`${session}|offer|${payload.sdp}`), payload.relay !== false) : payload;
        const sealed = await this.keys.sealMessage({ ...signed, sent_at: this.now() }, SealContext.signal(this.cameraId, viewer, session));
        return this.link.send(signalFrame(viewer, session, sealed));
    }

    /** How the camera is, sealed as its own. @param {Record<string, unknown>} status as `cameraStatus` writes it */
    async sendStatus(status) {
        const sealed = await this.keys.sealMessage({ ...status, sent_at: this.now() }, SealContext.status(this.cameraId));
        return this.link.send(statusFrame(sealed));
    }

    /** A still for a grid tile: packed to one size with its time inside,
     * sealed with the camera's media key as this camera's.
     * @param {Uint8Array} jpeg one that fits a peek frame @param {number} capturedAt ms */
    async sendStill(jpeg, capturedAt) {
        const sealed = await this.keys.sealMedia(packPeekFrame(jpeg, capturedAt), SealContext.peek(this.cameraId));
        if (sealed.length > MAX_PEEK_BYTES) return false;
        return this.link.sendBinary(sealed);
    }
}
