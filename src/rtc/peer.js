// One viewer's session on the camera: a peer connection of its own, sending
// as the apps' cameras send (PetCam/Realtime/CameraBroadcaster.swift,
// CameraPeer; docs/API.md, Realtime; docs/WEB-CAMERA.md § 5).
//
// - The camera makes the offer. Picture and sound are separate streams, so
//   the picture is never held back to line up with the sound.
// - H.264 first, VP8 as the fallback, nothing else offered.
// - Only the three header extensions a call can't do without (terms.js).
// - One data channel, `petcam`, opened before the offer: the camera's side
//   of the link goes to the viewer on it, and the viewer's cap, play, pause,
//   listen and video come back.
// - Nothing is encoded, of picture or sound, until the connection's own
//   report says it agreed an AES-GCM suite with the certificate the signed
//   answer named. Every session starts with its encodings off. A ready
//   session (`warm`) then stays that way until `play`.
// - The step it sends at is set with `setParameters`: a ceiling on the
//   bitrate, a frame rate, and how far the picture is scaled down.
// - A session made without the relay (its viewer's Relay switch is off:
//   relay.js) has no TURN server, takes none of the viewer's relay
//   candidates, and ends if its path turns out relayed all the same. Its
//   path is judged before anything is encoded, the moment the browser picks
//   another, as each relay candidate is left out, and at each tuning pass.

import { cameraStats, readPeerMessage } from '../wire/peer.js';
import { CAMERA_CAP, LADDER, ceilingOf, isTile, topOf } from './ladder.js';
import { keepsCandidate, pathRelays, readCandidate, withoutRelay, withoutRelayCandidates } from './relay.js';
import { extensionsIn, fingerprintsIn, withOnlyExtensions } from './sdp.js';
import { handshakeName, readingOf } from './stats.js';
import { HEADER_EXTENSIONS, TERMS, VIDEO_CODECS, VIDEO_HELPERS } from './terms.js';
import { StreamTuner } from './tuner.js';

/** What a page captures at: no step past it is ever sent. */
export const CAPTURE_FPS = 30;
/** How long after `play` the first reading is worth taking, in seconds: the
 * encoder reports no target for its first moments. */
const SETTLE_SECONDS = 1.5;

/**
 * The browser's pieces a session uses, handed in so nothing here reads a
 * global: the page passes the browser's own.
 * @typedef {object} Rtc
 * @property {typeof RTCPeerConnection} RTCPeerConnection
 * @property {{ getCapabilities: (kind: string) => { codecs: any[] } | null }} RTCRtpSender
 * @property {typeof MediaStream} MediaStream
 */

export class CameraPeer {
    /**
     * @param {{
     *   session: string, viewer: string, name: string | null,
     *   warm: boolean, cap: string, planCap: string, relayCap: string,
     *   video: MediaStreamTrack | null, audio: MediaStreamTrack | null,
     *   sourceShortSide: number,
     *   iceServers: RTCIceServer[],
     *   rtc: Rtc,
     *   terms?: import('./terms.js').Terms,
     *   at: () => number,
     *   preferVp8?: boolean,
     *   usesRelay?: boolean,
     * }} options `audio` null when the viewer wants no sound or the camera has no microphone; `at` in seconds; `usesRelay` false for a session made without the relay
     */
    constructor(options) {
        this.session = options.session;
        this.viewer = options.viewer;
        /** What the viewer's device is called, where its watch said. */
        this.name = options.name;
        /** Whether it may run through the relay: its viewer's watch didn't say otherwise. */
        this.usesRelay = options.usesRelay !== false;
        /** The ports of the viewer's relay candidates it left out. @type {Set<number>} */
        this.relayPortsLeftOut = new Set();
        /** The path the browser last said it picked, to judge again as relay candidates are left out. @type {{ localType: string | null, remoteType: string | null, remotePort: number | null } | null} */
        this.selectedPair = null;
        this.saidRelayedWithout = false;
        this.ice = null;
        this.rtc = options.rtc;
        this.terms = options.terms ?? TERMS;
        this.at = options.at;
        this.viewerCap = options.cap;
        this.planCap = options.planCap;
        this.relayCap = options.relayCap;
        this.sourceShortSide = options.sourceShortSide;
        this.wantsAudio = options.audio !== null;

        /** A ready session keeps its picture and sound off until the viewer opens it. */
        this.playing = !options.warm;
        this.playingSince = this.at();
        /** The viewer hears this camera: on unless it says otherwise (`listen`). */
        this.listening = true;
        /** The viewer wants the picture (`video`): off while it listens from its lock screen. */
        this.wantsVideo = true;
        /** The connection came up at least once. */
        this.hasConnected = false;
        /** The connection's own report met the terms: only then is anything encoded. */
        this.locked = false;
        /** What the lock stands for, once it holds: the media cipher and the handshake. @type {{ media: string, handshake: string } | null} */
        this.encryption = null;
        this.relayed = false;
        this.relayedSeconds = 0;
        this.lastTuned = null;
        this.closed = false;
        this.hasAnswer = false;
        this.pending = [];
        /** The fingerprints the viewer's signed answer named. @type {Set<string>} */
        this.signedFingerprints = new Set();
        /** The latest reading and what the viewer was told, for the camera's own screen and for tests. */
        this.last = null;
        this.writing = Promise.resolve();
        this.tuner = new StreamTuner(topOf(this.caps()));
        this.applied = null;

        /** @type {((candidate: { candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }) => void) | null} */
        this.onCandidate = null;
        /** The connection failed or closed. @type {(() => void) | null} */
        this.onClosed = null;
        /** Playing, connected, locked, listening or its cap changed. @type {(() => void) | null} */
        this.onChanged = null;
        /** It turned out to be relayed. @type {(() => void) | null} */
        this.onRelayed = null;
        /** Made without the relay, and relayed all the same: a relay its viewer holds reached this camera first. Said once. @type {(() => void) | null} */
        this.onRelayedWithout = null;
        /** The connection didn't meet the terms: `cipher` (not AES-GCM), `certificate` (not the signed answer's), `report` (the browser wouldn't say), with the report it was judged by. @type {((why: 'cipher' | 'certificate' | 'report', reading: import('./stats.js').Reading | null) => void) | null} */
        this.onRefused = null;

        // Without the relay its connection has no TURN server at all: the STUN servers stay, so it still finds a direct path.
        const pc = new this.rtc.RTCPeerConnection({ iceServers: this.usesRelay ? options.iceServers : withoutRelay(options.iceServers), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        this.pc = pc;
        this.stoppedByApi = true;

        // Picture and sound go both ways, as an app's camera offers them: the
        // viewer's push-to-talk comes back on the sound's. Each in a stream
        // of its own.
        const rung = LADDER[this.tuner.rung];
        const videoStream = new this.rtc.MediaStream();
        const video = pc.addTransceiver(options.video ?? 'video', {
            direction: 'sendrecv',
            streams: [videoStream],
            sendEncodings: [{ active: false, maxBitrate: ceilingOf(this.caps()), maxFramerate: rung.fps, scaleResolutionDownBy: Math.max(1, this.sourceShortSide / rung.height) }],
        });
        this.videoSender = video.sender;
        this.preferCodecs(video, options.preferVp8 === true);
        const audioStream = new this.rtc.MediaStream();
        const audio = pc.addTransceiver(options.audio ?? 'audio', { direction: options.audio ? 'sendrecv' : 'recvonly', streams: [audioStream], sendEncodings: [{ active: false }] });
        this.audioSender = options.audio ? audio.sender : null;
        for (const transceiver of [video, audio]) this.keepOnlyKnownExtensions(transceiver);

        this.channel = pc.createDataChannel('petcam', { ordered: true });
        this.channel.onmessage = (event) => this.heard(event.data);

        pc.onicecandidate = (event) => {
            const candidate = event.candidate;
            if (!candidate || !candidate.candidate) return;
            // A session without the relay has no relay candidate to send.
            if (!this.usesRelay && readCandidate(candidate.candidate)?.type === 'relay') return;
            this.onCandidate?.({ candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null });
        };
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            if (state === 'connected') this.connected();
            if (state === 'failed' || state === 'closed') this.onClosed?.();
        };
        // Nothing a viewer sends is taken up: no picture is ever shown here,
        // and there is no Talk in the first version, so no sound is played
        // either. The offer is still an app camera's, sound both ways, so a
        // call needs no change when Talk comes.
    }

    /** The caps in force: the viewer's, the camera's own, the plan's, and the relay's while relayed. */
    caps() {
        return [this.viewerCap, CAMERA_CAP, this.planCap, ...(this.relayed ? [this.relayCap] : [])];
    }

    /** H.264 first and VP8 after it (the other way round once H.264 has
     * failed here), with what carries their retransmissions, and nothing
     * else. Where a browser won't be told, its own order stands.
     * @param {RTCRtpTransceiver} transceiver @param {boolean} vp8First */
    preferCodecs(transceiver, vp8First) {
        try {
            const all = this.rtc.RTCRtpSender.getCapabilities('video')?.codecs ?? [];
            const is = (name) => (codec) => codec.mimeType.toLowerCase() === name.toLowerCase();
            const order = vp8First ? [...VIDEO_CODECS].reverse() : VIDEO_CODECS;
            const wanted = [...order.flatMap((name) => all.filter(is(name))), ...VIDEO_HELPERS.flatMap((name) => all.filter(is(name)))];
            if (wanted.some((codec) => VIDEO_CODECS.some((name) => is(name)(codec)))) transceiver.setCodecPreferences(wanted);
        } catch {
            // Its own order, then: H.264 or VP8 is in every browser's.
        }
    }

    /** Stops every header extension but the three a call needs, where the
     * browser has a call for that. The offer's text is gone over as well
     * (`makeOffer`), which is all an older Safari has.
     * @param {RTCRtpTransceiver} transceiver */
    keepOnlyKnownExtensions(transceiver) {
        if (typeof transceiver.getHeaderExtensionsToNegotiate !== 'function') {
            this.stoppedByApi = false;
            return;
        }
        try {
            const extensions = transceiver.getHeaderExtensionsToNegotiate();
            for (const extension of extensions) if (!HEADER_EXTENSIONS.includes(extension.uri)) extension.direction = 'stopped';
            transceiver.setHeaderExtensionsToNegotiate(extensions);
        } catch {
            this.stoppedByApi = false;
        }
    }

    /** The offer, to be signed and sealed by whoever holds the camera's keys. @returns {Promise<string>} */
    async makeOffer() {
        const offer = await this.pc.createOffer();
        const sdp = withOnlyExtensions(offer.sdp ?? '', HEADER_EXTENSIONS);
        await this.pc.setLocalDescription({ type: 'offer', sdp });
        this.watchPath();
        return sdp;
    }

    /** The viewer's answer, whose signature the caller has already checked:
     * `sdp` is the answer as it was signed. Without the relay, a relay
     * candidate written into it is left out, as a trickled one is. */
    async applyAnswer(sdp) {
        try {
            // An answer can't add what wasn't offered; one that tries isn't taken.
            if (extensionsIn(sdp).some((uri) => !HEADER_EXTENSIONS.includes(uri))) throw new Error('a header extension that was never offered');
            this.signedFingerprints = fingerprintsIn(sdp);
            if (!this.usesRelay) {
                const answer = withoutRelayCandidates(sdp);
                for (const port of answer.ports) this.relayPortsLeftOut.add(port);
                sdp = answer.sdp;
            }
            await this.pc.setRemoteDescription({ type: 'answer', sdp });
            this.hasAnswer = true;
            const waiting = this.pending;
            this.pending = [];
            for (const candidate of waiting) await this.pc.addIceCandidate(candidate).catch(() => {});
        } catch {
            this.onClosed?.();
        }
    }

    /** A session without the relay takes none of the viewer's relay
     * candidates, and notes their ports.
     * @param {{ candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }} candidate */
    async addCandidate(candidate) {
        if (!this.usesRelay && !keepsCandidate(candidate.candidate)) {
            // The relay may have reached this camera before word of it did: the path in use is judged again by this port.
            const port = readCandidate(candidate.candidate)?.port;
            if (port !== undefined && !this.relayPortsLeftOut.has(port)) {
                this.relayPortsLeftOut.add(port);
                this.endIfPathRelays();
            }
            return;
        }
        const init = { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? undefined, sdpMLineIndex: candidate.sdpMLineIndex ?? 0 };
        if (!this.hasAnswer) this.pending.push(init);
        else await this.pc.addIceCandidate(init).catch(() => {});
    }

    // ---- Without the relay: its path -----------------------------------------

    /** Hears of each path the browser picks, the moment it picks it, where
     * the browser says (its ICE transport's own event). Where it doesn't,
     * the connection's report is what the path is judged by. */
    watchPath() {
        if (this.usesRelay || this.ice) return;
        const ice = this.videoSender.transport?.iceTransport ?? null;
        if (!ice || typeof ice.getSelectedCandidatePair !== 'function') return;
        this.ice = ice;
        ice.onselectedcandidatepairchange = () => {
            const pair = ice.getSelectedCandidatePair();
            if (!pair) return;
            this.selectedPair = { localType: pair.local?.type ?? null, remoteType: pair.remote?.type ?? null, remotePort: typeof pair.remote?.port === 'number' ? pair.remote.port : null };
            this.endIfPathRelays();
        };
    }

    /** A session made without the relay whose path runs through one all the
     * same (`pathRelays`) ends: the camera is told, once.
     * @returns {boolean} whether it does */
    endIfPathRelays() {
        if (this.usesRelay || this.closed || !this.selectedPair || !pathRelays(this.selectedPair, this.relayPortsLeftOut)) return false;
        if (!this.saidRelayedWithout) {
            this.saidRelayedWithout = true;
            this.onRelayedWithout?.();
        }
        return true;
    }

    /** The same, by the path a report says the transport is using.
     * @param {import('./stats.js').Reading} reading @returns {boolean} */
    relayedWithout(reading) {
        if (this.usesRelay || !reading.path) return false;
        this.selectedPair = { localType: reading.path.localType, remoteType: reading.path.remoteType, remotePort: reading.path.remotePort };
        return this.endIfPathRelays();
    }

    /** Without the relay, its path is looked at as it starts to play, not
     * only as it connects and at each tuning pass. */
    async lookAtPath() {
        if (this.usesRelay || this.closed || this.endIfPathRelays()) return;
        try {
            const reading = readingOf(await this.pc.getStats());
            if (!this.closed) this.relayedWithout(reading);
        } catch {
            // The next look finds out.
        }
    }

    /** The connection is up: its own report decides whether anything is sent on it. */
    async connected() {
        if (!this.hasConnected) {
            this.hasConnected = true;
            this.onChanged?.();
        }
        if (this.locked || this.checking) return;
        this.checking = true;
        try {
            // The report can trail the connection by a moment.
            for (let tries = 0; tries < 20 && !this.closed; tries++) {
                const reading = readingOf(await this.pc.getStats());
                const transport = reading.transport;
                // Without the relay, the report has to say which path it's on as well: nothing is encoded on one that hasn't been judged.
                if (transport?.dtlsState === 'connected' && transport.srtpCipher && (this.usesRelay || reading.path)) {
                    if (!this.terms.srtp(transport.srtpCipher)) return this.onRefused?.('cipher', reading);
                    if (!transport.remoteFingerprint || !this.signedFingerprints.has(transport.remoteFingerprint)) return this.onRefused?.('certificate', reading);
                    if (this.relayedWithout(reading)) return;
                    this.locked = true;
                    this.encryption = { media: transport.srtpCipher, handshake: handshakeName(transport.tlsVersion) };
                    this.playingSince = this.at();
                    this.write();
                    this.onChanged?.();
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!this.closed) this.onRefused?.('report', null);
        } catch {
            if (!this.closed) this.onRefused?.('report', null);
        } finally {
            this.checking = false;
        }
    }

    /** A message on the data channel. @param {unknown} data */
    heard(data) {
        if (typeof data !== 'string') return;
        let json;
        try {
            json = JSON.parse(data);
        } catch {
            return;
        }
        const message = readPeerMessage(json);
        if (!message) return;
        switch (message.type) {
            case 'cap':
                if (message.quality !== null) this.setCap(message.quality);
                break;
            case 'play':
                this.setPlaying(true);
                break;
            case 'pause':
                this.setPlaying(false);
                break;
            case 'listen':
                this.setListening(message.on ?? true);
                break;
            case 'video':
                this.setVideo(message.on ?? true);
                break;
            default:
                break;
        }
    }

    /** @param {string} cap one of the caps the apps know */
    setCap(cap) {
        if (cap === this.viewerCap || this.closed) return;
        this.viewerCap = cap;
        this.capsChanged();
        this.onChanged?.();
    }

    /** @param {string} cap */
    setPlanCap(cap) {
        this.planCap = cap;
        this.capsChanged();
    }

    /** @param {string} cap */
    setRelayCap(cap) {
        this.relayCap = cap;
        if (this.relayed) this.capsChanged();
    }

    capsChanged() {
        this.tuner.top = topOf(this.caps());
        this.write();
    }

    /** Turns this viewer's picture and sound on or off. Turning the picture
     * back on makes the browser start with a keyframe, so it's there at once. */
    setPlaying(playing) {
        if (playing === this.playing || this.closed) return;
        this.playing = playing;
        // Relayed time counts while it plays, from its next reading.
        this.lastTuned = null;
        if (playing) this.playingSince = this.at();
        // Without the relay, its path is looked at again before its picture and sound are turned on: a session that ends for it is closed by then, and nothing is written.
        if (playing && !this.usesRelay) this.writing = this.writing.then(() => this.lookAtPath()).catch(() => {});
        this.write();
        this.onChanged?.();
    }

    /** A grid tile that isn't the one listened to gets no sound. */
    setListening(listening) {
        if (listening === this.listening || this.closed) return;
        this.listening = listening;
        this.write();
        this.onChanged?.();
    }

    /** A viewer listening from its lock screen gets sound only. */
    setVideo(on) {
        if (on === this.wantsVideo || this.closed) return;
        this.wantsVideo = on;
        this.write();
        this.onChanged?.();
    }

    /** Whether this session shows a live view on its viewer's screen, and not a grid tile's. */
    get isLiveView() {
        return this.playing && this.wantsVideo && !isTile(this.viewerCap);
    }

    /** Whether someone is really watching: connected on the terms, and playing. */
    get isWatching() {
        return this.playing && this.hasConnected && this.locked;
    }

    /** Writes what should be sent now to both senders. Changes are written
     * one after another: a browser takes one `setParameters` at a time. */
    write() {
        this.writing = this.writing.then(() => this.writeNow()).catch(() => {});
        return this.writing;
    }

    async writeNow() {
        if (this.closed) return;
        const step = this.tuner.rung;
        const rung = LADDER[step];
        const video = { active: this.locked && this.playing && this.wantsVideo, maxBitrate: ceilingOf(this.caps()), maxFramerate: rung.fps, scaleResolutionDownBy: Math.max(1, this.sourceShortSide / rung.height) };
        const audio = { active: this.locked && this.playing && this.listening };
        await this.set(this.videoSender, video, true);
        await this.set(this.audioSender, audio, false);
        this.applied = { step, shortSide: this.sourceShortSide, video, audio };
    }

    /** @param {RTCRtpSender | null} sender @param {Record<string, unknown>} wanted @param {boolean} balanced */
    async set(sender, wanted, balanced) {
        if (!sender) return;
        for (const withPreference of balanced ? [true, false] : [false]) {
            const parameters = sender.getParameters();
            if (!parameters.encodings || parameters.encodings.length === 0) return;
            for (const encoding of parameters.encodings) Object.assign(encoding, wanted);
            // Under sudden pressure the browser trims frame rate and size together; the tuner moves between steps on top of that.
            if (withPreference) parameters.degradationPreference = 'balanced';
            try {
                await sender.setParameters(parameters);
                return;
            } catch {
                // Once more without the preference, for a browser that won't take it.
            }
        }
    }

    /** One tuning pass: read the report, move the step if the link says so,
     * and tell the viewer how the camera's side looks.
     * @param {number} sourceShortSide the short side of what the camera captures now */
    async tune(sourceShortSide) {
        if (this.closed || !this.hasAnswer || !this.locked || !this.playing || this.at() - this.playingSince <= SETTLE_SECONDS) return;
        const reading = readingOf(await this.pc.getStats());
        if (this.closed || this.relayedWithout(reading)) return;
        this.noteRelay(reading);
        const link = this.tuner.update(reading, { at: this.at(), maxFps: CAPTURE_FPS });
        this.sourceShortSide = sourceShortSide;
        if (this.applied?.step !== this.tuner.rung || this.applied?.shortSide !== sourceShortSide) this.write();
        this.last = { reading, link };
        if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(cameraStats(link)));
    }

    /** Whether the call runs through the relay, and while it does and plays,
     * for how long: a relayed session is held to the relay's cap, and its
     * time counts for the home's relay hours.
     * @param {import('./stats.js').Reading} reading */
    noteRelay(reading) {
        const now = this.at();
        const relayed = reading.path ? reading.path.relayed : this.relayed;
        if (relayed && this.lastTuned !== null) this.relayedSeconds += Math.min(now - this.lastTuned, 10);
        this.lastTuned = now;
        if (relayed === this.relayed) return;
        this.relayed = relayed;
        this.capsChanged();
        if (relayed) this.onRelayed?.();
    }

    /** Relayed seconds since the last call. */
    takeRelayedSeconds() {
        const seconds = this.relayedSeconds;
        this.relayedSeconds = 0;
        return seconds;
    }

    /** The camera's source has a new track to send, or lost one.
     * @param {MediaStreamTrack | null} video @param {MediaStreamTrack | null} audio */
    replaceTracks(video, audio) {
        if (this.closed) return;
        this.videoSender.replaceTrack(video).catch(() => {});
        this.audioSender?.replaceTrack(audio).catch(() => {});
    }

    /** A reading of how it stands now, whether or not it plays. @returns {Promise<import('./stats.js').Reading>} */
    async read() {
        return readingOf(await this.pc.getStats());
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        if (this.ice) this.ice.onselectedcandidatepairchange = null;
        this.channel.onmessage = null;
        try {
            this.channel.close();
        } catch {
            // Already closed.
        }
        this.pc.close();
    }
}
