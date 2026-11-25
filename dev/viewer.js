// A stand-in for a viewer, for a page of tests: it does what the apps'
// viewer does on a call (PetCam/Realtime/ViewerSession.swift). It sends a
// sealed `watch`, takes the camera's offer only if its signature holds,
// answers with a signed answer, and gives its lock only when the
// connection's certificate is the one the signed offer named.
//
// It holds the camera's own keys, as a home's members will from the
// camera's entry (docs/WEB-CAMERA.md § 3), and never a key of a home's:
// there is no home in a test page. It isn't a viewer anyone could use: it
// shows nothing, and a browser is only ever a camera.

import { SealContext } from '../src/crypto/keys.js';
import { randomId } from '../src/crypto/primitives.js';
import { fingerprintsIn } from '../src/rtc/sdp.js';
import { readingOf } from '../src/rtc/stats.js';
import { isGcm } from '../src/rtc/terms.js';
import { readFrame } from '../src/wire/frames.js';
import { readSignal } from '../src/wire/signal.js';

export class StandInViewer {
    /**
     * @param {{ id: string, cameraId: string, keys: import('../src/crypto/keys.js').KeySet, link: import('../src/camera/link.js').Link, doc: Document, now?: () => number }} options
     */
    constructor(options) {
        this.id = options.id;
        this.cameraId = options.cameraId;
        this.keys = options.keys;
        this.link = options.link;
        this.doc = options.doc;
        this.now = options.now ?? (() => Date.now());
        this.session = null;
        this.pc = null;
        this.channel = null;
        /** Every signal the camera sent this viewer, opened, in order. */
        this.heard = [];
        /** Every message on the data channel. */
        this.told = [];
        /** Frames that came for this viewer and didn't open. */
        this.unopened = 0;
        this.offer = null;
        /** What this end's report said as the camera ended the call. */
        this.final = null;
        this.answer = null;
        this.offerSigned = null;
        this.signedFingerprints = new Set();
        this.elements = [];
        this.ear = null;
        this.remoteCandidates = true;
        /** Set to change what goes out, for tests of what a camera refuses. */
        this.tamper = { answerSig: null };
        /** Where to send candidates instead of the camera's own: a forwarder's address. @type {string | null} */
        this.only = null;
        this.queue = Promise.resolve();
        this.link.onText = (text) => {
            this.queue = this.queue.then(() => this.receive(text)).catch((error) => this.heard.push({ kind: 'error', error: String(error?.message ?? error) }));
        };
    }

    /** @param {Record<string, unknown>} payload @param {{ session?: string, sentAt?: number, keys?: import('../src/crypto/keys.js').KeySet, to?: string }} [how] */
    async signal(payload, how = {}) {
        const session = how.session ?? this.session;
        const to = how.to ?? this.cameraId;
        const sealed = await (how.keys ?? this.keys).sealMessage({ ...payload, sent_at: how.sentAt ?? this.now() }, SealContext.signal(this.id, to, session));
        this.link.send(JSON.stringify({ type: 'signal', to: this.cameraId, session, payload: sealed }));
    }

    /** Asks the camera to start a session. @param {{ warm?: boolean, audio?: boolean, quality?: string, session?: string, sentAt?: number }} [terms] */
    async watch(terms = {}) {
        this.session = terms.session ?? randomId();
        const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        this.pc = pc;
        pc.onicecandidate = (event) => {
            if (event.candidate?.candidate && this.only === null) this.signal({ kind: 'candidate', candidate: event.candidate.candidate, sdp_mid: event.candidate.sdpMid, sdp_m_line_index: event.candidate.sdpMLineIndex });
        };
        pc.ondatachannel = (event) => {
            this.channel = event.channel;
            event.channel.onmessage = (message) => this.told.push(JSON.parse(String(message.data)));
        };
        pc.ontrack = (event) => {
            // Decoded into an element nobody sees or hears, so the browser decodes at all.
            const element = this.doc.createElement(event.track.kind === 'video' ? 'video' : 'audio');
            element.muted = true;
            element.autoplay = true;
            element.playsInline = true;
            element.className = 'received';
            element.srcObject = new MediaStream([event.track]);
            this.doc.body.append(element);
            element.play?.()?.catch?.(() => {});
            this.elements.push(element);
        };
        const { session: _session, sentAt, ...asked } = terms;
        await this.signal({ kind: 'watch', audio: true, quality: 'auto', ...asked }, { sentAt });
        return this.session;
    }

    /** @param {string} text */
    async receive(text) {
        const frame = readFrame(text);
        if (!frame) return;
        if (frame.type === 'error') {
            this.heard.push({ kind: 'error', code: frame.code });
            return;
        }
        if (frame.type !== 'signal') return;
        let opened;
        try {
            opened = await this.keys.openMessage(frame.payload, SealContext.signal(frame.from, this.id, frame.session), { fresh: true });
        } catch {
            this.unopened += 1;
            return;
        }
        const signal = readSignal(opened);
        if (!signal) return;
        this.heard.push({ ...signal, session: frame.session });
        if (frame.session !== this.session || !this.pc) return;
        if (signal.kind === 'offer') {
            this.offer = signal.sdp;
            this.offerSigned = await this.keys.verify(`${frame.session}|offer|${signal.sdp}`, signal.sig);
            if (!this.offerSigned) {
                await this.signal({ kind: 'bye', reason: 'bad_signature' });
                return;
            }
            this.signedFingerprints = fingerprintsIn(signal.sdp);
            await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.answer = answer.sdp;
            await this.signal({ kind: 'answer', sdp: answer.sdp, sig: this.tamper.answerSig ?? (await this.keys.sign(`${frame.session}|answer|${answer.sdp}`)) });
            if (this.only !== null) await this.pc.addIceCandidate({ candidate: this.only, sdpMid: '0', sdpMLineIndex: 0 });
        } else if (signal.kind === 'candidate') {
            if (this.only === null && this.remoteCandidates) await this.pc.addIceCandidate({ candidate: signal.candidate, sdpMid: signal.sdpMid ?? undefined, sdpMLineIndex: signal.sdpMLineIndex ?? 0 }).catch(() => {});
        } else if (signal.kind === 'bye') {
            // One last look at what arrived, before the call is gone.
            this.final = await this.look().catch(() => null);
            this.close();
        }
    }

    /** A message to the camera on the data channel. @param {Record<string, unknown>} message */
    tell(message) {
        this.channel.send(JSON.stringify(message));
    }

    /** A sealed command to the camera. @param {Record<string, unknown>} command @param {{ id?: string, sentAt?: number }} [how] */
    async command(command, how = {}) {
        const sealed = await this.keys.sealMessage({ command, sent_at: how.sentAt ?? this.now(), id: how.id ?? randomId() }, SealContext.command(this.id, this.cameraId));
        this.link.send(JSON.stringify({ type: 'command', to: this.cameraId, command: sealed }));
    }

    /** What this end's report says of the call: what arrived, and how it's protected. */
    async look() {
        if (!this.pc) return null;
        const report = await this.pc.getStats();
        const reading = readingOf(report);
        const inbound = { video: null, audio: null };
        const codecs = new Map();
        report.forEach((stat) => {
            if (stat.type === 'codec') codecs.set(stat.id, stat.mimeType);
        });
        report.forEach((stat) => {
            if (stat.type !== 'inbound-rtp') return;
            inbound[stat.kind] = {
                packetsReceived: stat.packetsReceived ?? 0, bytesReceived: stat.bytesReceived ?? 0, packetsLost: stat.packetsLost ?? 0, codec: codecs.get(stat.codecId) ?? null,
                ...(stat.kind === 'video' ? { framesDecoded: stat.framesDecoded ?? 0, framesReceived: stat.framesReceived ?? 0, width: stat.frameWidth ?? null, height: stat.frameHeight ?? null, fps: stat.framesPerSecond ?? null, keyFramesDecoded: stat.keyFramesDecoded ?? null, decoder: stat.decoderImplementation ?? null } : { energy: stat.totalAudioEnergy ?? null, level: stat.audioLevel ?? null }),
            };
        });
        const transport = reading.transport;
        return {
            state: this.pc.connectionState,
            cipher: transport?.srtpCipher ?? null,
            handshake: transport?.tlsVersion ?? null,
            path: reading.path,
            // The apps' lock: an AES-GCM suite, with the certificate the signed offer named.
            certificateIsTheSignedOne: Boolean(transport?.remoteFingerprint && this.signedFingerprints.has(transport.remoteFingerprint)),
            lock: Boolean(transport?.dtlsState === 'connected' && isGcm(transport.srtpCipher) && transport.remoteFingerprint && this.signedFingerprints.has(transport.remoteFingerprint)),
            video: inbound.video,
            audio: inbound.audio,
        };
    }

    /** What the sound that arrives is: how loud, and its strongest pitch.
     * Null where this browser won't run the listening (no tap, no sound).
     * Nothing is played: the listening ends in a volume of nothing.
     * @returns {{ db: number, hz: number } | null} */
    hears() {
        const track = this.pc?.getReceivers().find((receiver) => receiver.track?.kind === 'audio')?.track;
        if (!track) return null;
        if (!this.ear) {
            const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
            const context = new Context();
            const analyser = context.createAnalyser();
            analyser.fftSize = 4096;
            const silent = context.createGain();
            silent.gain.value = 0;
            context.createMediaStreamSource(new MediaStream([track])).connect(analyser).connect(silent).connect(context.destination);
            context.resume?.().catch(() => {});
            this.ear = { context, analyser, wave: new Float32Array(analyser.fftSize), spectrum: new Float32Array(analyser.frequencyBinCount) };
        }
        const { context, analyser, wave, spectrum } = this.ear;
        if (context.state !== 'running') return null;
        analyser.getFloatTimeDomainData(wave);
        let sum = 0;
        for (const sample of wave) sum += sample * sample;
        analyser.getFloatFrequencyData(spectrum);
        let loudest = 0;
        for (let i = 1; i < spectrum.length; i++) if (spectrum[i] > spectrum[loudest]) loudest = i;
        return { db: 10 * Math.log10(sum / wave.length + 1e-12), hz: (loudest * context.sampleRate) / analyser.fftSize };
    }

    async bye(reason) {
        await this.signal(reason ? { kind: 'bye', reason } : { kind: 'bye' });
        this.close();
    }

    close() {
        for (const element of this.elements) element.remove();
        this.elements = [];
        this.ear?.context.close().catch(() => {});
        this.ear = null;
        this.pc?.close();
        this.pc = null;
    }
}
