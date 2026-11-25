// The camera's side of live viewing: one session a viewer, all of them
// sending the same picture and sound (the apps' CameraBroadcaster,
// PetCam/Realtime/CameraBroadcaster.swift).
//
// Offers come from the camera. A viewer sends `watch`; the camera answers
// with an offer; the viewer returns an answer. What's sealed and signed is
// done by whoever holds the camera's keys (src/camera/signals.js): this
// part is handed signals already opened and judged fresh, and hands back
// what to send.
//
// A session has the relay as the home's plan allows unless its viewer's
// watch said `relay: false` (relay.js): a page has no Relay switch of its
// own, so the watch alone decides, session by session.

import { BYE, byeSignal, candidateSignal } from '../wire/signal.js';
import { CameraPeer } from './peer.js';
import { RelayOffHolds } from './relay.js';
import { TERMS } from './terms.js';

/** A session that never connects goes after this long, instead of counting
 * as someone there for as long as the camera runs. */
export const NEVER_CONNECTED_MS = 30_000;
/** How long a session's id is remembered, so a watch the server plays back starts nothing. */
const SEEN_FOR_MS = 300_000;
/** How often each playing session's step is looked at again. */
const TUNE_EVERY_MS = 2_000;
/** How long H.264 may encode nothing, with a picture to send, before VP8 goes first for the sessions after. */
const H264_GIVEN_MS = 8_000;

/**
 * Who's watching, for the camera's screen and its status.
 * @typedef {{ session: string, viewer: string, name: string | null, listening: boolean, video: boolean, tile: boolean, encryption: { media: string, handshake: string } | null }} Watcher
 */

export class CameraBroadcaster {
    /**
     * @param {{
     *   tracks: () => { video: MediaStreamTrack | null, audio: MediaStreamTrack | null, shortSide: number },
     *   iceServers: () => Promise<RTCIceServer[]>,
     *   send: (viewer: string, session: string, payload: Record<string, unknown>) => void,
     *   rtc: import('./peer.js').Rtc,
     *   clock: { now: () => number, at: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void, setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (id: any) => void },
     *   terms?: import('./terms.js').Terms,
     *   onWatchers?: (watchers: Watcher[]) => void,
     * }} options `clock.now` in ms, `clock.at` in seconds from a clock that only goes forward; an offer goes to `send` without its `sig`
     */
    constructor(options) {
        this.options = options;
        this.terms = options.terms ?? TERMS;
        /** @type {Map<string, CameraPeer>} */
        this.peers = new Map();
        /** Watches still setting up (relay addresses being fetched), by session, with their viewer. @type {Map<string, string>} */
        this.starting = new Map();
        /** @type {Set<string>} */
        this.cancelled = new Set();
        /** @type {Map<string, number>} */
        this.seen = new Map();
        this.tuning = null;
        /** The most the home's plan lets any session have. */
        this.planCap = 'auto';
        /** The most it lets a relayed one have. */
        this.relayCap = 'medium';
        /** Whether the home has relay hours left this month. */
        this.relayAllowed = true;
        /** Viewers whose last session was made without the relay and ended for a relayed path. */
        this.relayOffHolds = new RelayOffHolds();
        this.endedRelayedSeconds = 0;
        /** H.264 produced nothing on this device: VP8 goes first from here on. */
        this.preferVp8 = false;
        /** The last few calls that were turned away for not meeting the terms, with what the connection's own report said: nothing of the room went out on any of them. @type {{ session: string, viewer: string, why: string, cipher: string | null, framesEncoded: number, packetsOfSound: number }[]} */
        this.refused = [];
        this.lastWatchers = '[]';
    }

    // ---- Signals in --------------------------------------------------------

    /**
     * A viewer asks to watch.
     * @param {string} viewer its device id @param {string} session
     * @param {{ audio: boolean, quality: string, warm: boolean, relay?: boolean }} terms as `watchTerms` reads them; `relay` false for a viewer whose Relay switch is off
     * @param {string | null} [name] what the viewer's device is called, where the watch says
     */
    async watch(viewer, session, terms, name = null) {
        const now = this.options.clock.now();
        for (const [id, at] of this.seen) if (now - at >= SEEN_FOR_MS) this.seen.delete(id);
        // A second watch for a session already started is a replay.
        if (this.seen.has(session)) return;
        this.seen.set(session, now);
        // A page has no Relay switch of its own: the watch alone decides
        // whether this session has the relay (docs/API.md, Temporary cameras).
        const relay = terms.relay !== false;
        // Its last session without the relay just ended for a relayed path,
        // and it asks the same way again: answered the same way for half a
        // minute, with nothing set up to relay. A watch that doesn't ask to
        // go without is set up as any is: `relay_off` would tell its viewer
        // of a switch a page doesn't have.
        if (!relay && this.relayOffHolds.holds(viewer, now)) {
            this.options.send(viewer, session, byeSignal(BYE.relayOff));
            return;
        }
        this.starting.set(session, viewer);
        let iceServers = [];
        try {
            iceServers = await this.options.iceServers();
        } catch {
            // With no list, a call has the addresses the two devices have themselves.
        }
        this.starting.delete(session);
        // Ended while the addresses came: a bye, the viewer leaving, or the camera stopping.
        if (this.cancelled.delete(session)) return;
        if (this.peers.has(session)) this.end(session, null, false);

        const { video, audio, shortSide } = this.options.tracks();
        let peer;
        try {
            peer = new CameraPeer({
                session, viewer, name, warm: terms.warm, cap: terms.quality, planCap: this.planCap, relayCap: this.relayCap,
                video, audio: terms.audio ? audio : null, sourceShortSide: shortSide, iceServers,
                rtc: this.options.rtc, terms: this.terms, at: this.options.clock.at, preferVp8: this.preferVp8, usesRelay: relay,
            });
        } catch {
            this.options.send(viewer, session, byeSignal(BYE.offerFailed));
            return;
        }
        peer.onCandidate = (candidate) => this.options.send(viewer, session, candidateSignal(candidate));
        peer.onClosed = () => this.end(session, null, false);
        peer.onChanged = () => this.changed();
        peer.onRelayed = () => {
            if (!this.relayAllowed) this.end(session, BYE.relayLimit);
        };
        // Made without the relay, and its path is relayed all the same: it
        // ends, its viewer is told why, and is held off for half a minute.
        peer.onRelayedWithout = () => {
            if (this.peers.get(session) !== peer) return;
            this.relayOffHolds.ended(viewer, this.options.clock.now());
            this.end(session, BYE.relayOff);
        };
        // A connection that didn't come out on the terms carries nothing, and ends.
        peer.onRefused = (why, reading) => {
            this.refused.push({ session, viewer, why, cipher: reading?.transport?.srtpCipher ?? null, framesEncoded: reading?.video?.framesEncoded ?? 0, packetsOfSound: reading?.audio?.packetsSent ?? 0 });
            if (this.refused.length > 10) this.refused.shift();
            this.end(session, null);
        };
        this.peers.set(session, peer);
        this.changed();
        this.options.clock.setTimeout(() => {
            if (this.peers.get(session) === peer && !peer.hasConnected) this.end(session, BYE.timeout);
        }, NEVER_CONNECTED_MS);
        try {
            const sdp = await peer.makeOffer();
            // `relay: false` says this side has no relay for the session, and is never said as true: with the relay the offer says nothing of it.
            if (this.peers.get(session) === peer) this.options.send(viewer, session, { kind: 'offer', sdp, ...(relay ? {} : { relay: false }) });
        } catch {
            this.end(session, BYE.offerFailed);
        }
    }

    /** The viewer's answer, its signature already checked. @param {string} viewer @param {string} session @param {string} sdp */
    async answer(viewer, session, sdp) {
        const peer = this.peers.get(session);
        if (!peer || peer.viewer !== viewer) return;
        await peer.applyAnswer(sdp);
    }

    /** @param {string} viewer @param {string} session @param {{ candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }} candidate */
    async candidate(viewer, session, candidate) {
        const peer = this.peers.get(session);
        if (!peer || peer.viewer !== viewer) return;
        await peer.addCandidate(candidate);
    }

    /** The viewer ended its session. @param {string} viewer @param {string} session */
    bye(viewer, session) {
        if ((this.peers.get(session)?.viewer ?? this.starting.get(session)) !== viewer) return;
        if (this.starting.has(session)) this.cancelled.add(session);
        this.end(session, null, false);
    }

    /** An answer that didn't check out: the session ends, and the viewer is
     * told the camera couldn't take it. @param {string} session */
    refuse(session) {
        this.end(session, BYE.badSignature);
    }

    // ---- Sessions ----------------------------------------------------------

    /** @param {string} session @param {string | null} reason one of `BYE`, or none @param {boolean} [notify] */
    end(session, reason, notify = true) {
        const peer = this.peers.get(session);
        if (!peer) return;
        this.peers.delete(session);
        this.endedRelayedSeconds += peer.takeRelayedSeconds();
        if (notify) this.options.send(peer.viewer, session, byeSignal(reason));
        peer.close();
        this.changed();
    }

    /** A viewer is known to have gone: its sessions go, and any still
     * starting. A temporary camera's socket carries no presence, so nothing
     * in the page learns this but from the connection itself; the test
     * bridge, which reads a Worker's presence, says so through here.
     * @param {string} viewer */
    viewerLeft(viewer) {
        for (const [session, who] of this.starting) if (who === viewer) this.cancelled.add(session);
        for (const peer of [...this.peers.values()]) if (peer.viewer === viewer) this.end(peer.session, null, false);
    }

    /** The camera stops: every viewer is told. @param {string} [reason] */
    endAll(reason = BYE.cameraStopped) {
        for (const session of this.starting.keys()) this.cancelled.add(session);
        for (const session of [...this.peers.keys()]) this.end(session, reason);
        if (this.tuning !== null) this.options.clock.clearInterval(this.tuning);
        this.tuning = null;
    }

    /** Who's really watching now: sessions that play, on a connection that met the terms. @returns {Watcher[]} */
    watchers() {
        return [...this.peers.values()].filter((peer) => peer.isWatching).map((peer) => ({
            session: peer.session, viewer: peer.viewer, name: peer.name, listening: peer.wantsAudio && peer.listening, video: peer.wantsVideo, tile: !peer.isLiveView, encryption: peer.encryption,
        }));
    }

    changed() {
        const watchers = this.watchers();
        if ([...this.peers.values()].some((peer) => peer.playing) && this.tuning === null) {
            this.tuning = this.options.clock.setInterval(() => this.tune(), TUNE_EVERY_MS);
        }
        const text = JSON.stringify(watchers);
        if (text === this.lastWatchers) return;
        this.lastWatchers = text;
        this.options.onWatchers?.(watchers);
    }

    /** Every two seconds each playing viewer's step is looked at again; with
     * none playing (ready connections only), the looking stops. */
    async tune() {
        const peers = [...this.peers.values()];
        if (!peers.some((peer) => peer.playing)) {
            if (this.tuning !== null) this.options.clock.clearInterval(this.tuning);
            this.tuning = null;
            return;
        }
        const { video, shortSide } = this.options.tracks();
        for (const peer of peers) {
            await peer.tune(shortSide).catch(() => {});
            this.noteEncoder(peer, video);
        }
    }

    /** H.264 that encodes nothing while there's a picture to send (an old
     * phone's hardware encoder giving up) puts VP8 first for the sessions
     * after this one, and ends this one so its viewer asks again.
     * @param {CameraPeer} peer @param {MediaStreamTrack | null} video */
    noteEncoder(peer, video) {
        const sent = peer.last?.reading.video;
        if (this.preferVp8 || !sent || !peer.isWatching || !peer.wantsVideo || !video || video.muted || video.readyState !== 'live') return;
        if (!/h264/i.test(sent.codec ?? '') || (sent.framesEncoded ?? 0) > 0) return;
        if ((this.options.clock.at() - peer.playingSince) * 1000 < H264_GIVEN_MS) return;
        this.preferVp8 = true;
        this.end(peer.session, null);
    }

    // ---- The plan, the relay, the source ------------------------------------

    /** @param {string} cap */
    setPlanCap(cap) {
        this.planCap = cap;
        for (const peer of this.peers.values()) peer.setPlanCap(cap);
    }

    /** @param {string} cap */
    setRelayCap(cap) {
        this.relayCap = cap;
        for (const peer of this.peers.values()) peer.setRelayCap(cap);
    }

    /** Without relay hours left, a session that turns out to be relayed ends. @param {boolean} allowed */
    setRelayAllowed(allowed) {
        this.relayAllowed = allowed;
        if (allowed) return;
        for (const peer of [...this.peers.values()]) if (peer.relayed) this.end(peer.session, BYE.relayLimit);
    }

    /** Seconds of video sent through the relay since the last call, for the home's relay hours. */
    takeRelayedSeconds() {
        let seconds = this.endedRelayedSeconds;
        this.endedRelayedSeconds = 0;
        for (const peer of this.peers.values()) seconds += peer.takeRelayedSeconds();
        return seconds;
    }

    /** The source has a new track to send, or lost one: every session sends what it has now. */
    tracksChanged() {
        const { video, audio } = this.options.tracks();
        for (const peer of this.peers.values()) peer.replaceTracks(video, peer.wantsAudio ? audio : null);
    }
}
