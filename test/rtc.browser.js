// A camera's sending half on a real call, both ends in one page: the page's
// own sessions and signalling (src/rtc/, src/camera/signals.js) against a
// stand-in viewer that does what the apps' viewer does (dev/viewer.js),
// through a stand-in for the Worker's socket (dev/relay.js). The picture is
// drawn and the sound is a made tone.
//
// What's read here is read off the connections' own reports, and for one
// test off the wire itself, through a forwarder on this computer.
//
// One thing a page of tests can't show is a call on AES-GCM: two browsers
// agree AES-CM with each other, whatever a page does. So the first test
// here is that the camera then sends nothing, and the rest run on terms
// loosened for tests (dev/any-suite.js). The call with the app, which
// lists AES-GCM alone, is the other half.

import { ANY_SUITE_FOR_TESTS } from '../dev/any-suite.js';
import { A_DRAWN_PHONE, DrawnDevices, TONE_HZ } from '../dev/drawn.js';
import { Relay } from '../dev/relay.js';
import { StandInViewer } from '../dev/viewer.js';
import { CameraSignals } from '../src/camera/signals.js';
import { DeviceSource } from '../src/capture/source.js';
import { b64url } from '../src/crypto/bytes.js';
import { KeySet } from '../src/crypto/keys.js';
import { randomBytes, randomId } from '../src/crypto/primitives.js';
import { CameraBroadcaster } from '../src/rtc/broadcaster.js';
import { LADDER } from '../src/rtc/ladder.js';
import { isRelayUrl, readCandidate } from '../src/rtc/relay.js';
import { codecsIn, directionsIn, extensionsIn } from '../src/rtc/sdp.js';
import { HEADER_EXTENSIONS, isGcm } from '../src/rtc/terms.js';
import { readPeerMessage } from '../src/wire/peer.js';
import { assert, note, sleep, suite, test, until } from './lib/harness.js';

suite('a call in this browser');

const clock = {
    now: () => Date.now(),
    at: () => performance.now() / 1000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
};

/** A camera and a viewer in this page, holding the same camera's keys. @param {{ terms?: import('../src/rtc/terms.js').Terms, iceServers?: RTCIceServer[] }} [how] */
async function world(how = {}) {
    const cameraId = randomId();
    const viewerId = randomId();
    const secret = randomBytes(32);
    const cameraKeys = await KeySet.forCamera(Uint8Array.from(secret), 7);
    const memberKeys = await KeySet.forCamera(Uint8Array.from(secret), 7);
    const relay = new Relay();
    const devices = new DrawnDevices(document, A_DRAWN_PHONE);
    const source = new DeviceSource(devices, 'android_phone');
    await source.start();
    /** What the sessions handed over to be sealed and sent, as they handed it. */
    const sent = [];
    const watchersSeen = [];
    let signals;
    const broadcaster = new CameraBroadcaster({
        tracks: () => ({ video: source.video, audio: source.audio, shortSide: 720 }),
        iceServers: async () => how.iceServers ?? [],
        send: (viewer, session, payload) => {
            sent.push({ viewer, session, payload });
            return signals.send(viewer, session, payload);
        },
        rtc: { RTCPeerConnection, RTCRtpSender, MediaStream },
        clock,
        terms: how.terms,
        onWatchers: (watchers) => watchersSeen.push(watchers),
    });
    signals = new CameraSignals({ keys: cameraKeys, cameraId, link: relay.join(cameraId), broadcaster, now: clock.now });
    const viewer = new StandInViewer({ id: viewerId, cameraId, keys: memberKeys, link: relay.join(viewerId), doc: document });
    let forwarder = null;
    return {
        cameraId, viewerId, relay, devices, source, broadcaster, signals, viewer, sent, watchersSeen, memberKeys,
        /** The viewer asks to watch, and the call that follows goes through a
         * forwarder on this computer: two ends in one page reach each other
         * through it in every browser, and it reads what passes.
         * @param {Record<string, unknown>} [terms] */
        async watch(terms) {
            forwarder = await (await fetch('/__forwarder', { method: 'POST' })).json();
            viewer.only = forwarder.second;
            const session = await viewer.watch(terms);
            await until(() => viewer.offer, "the camera's offer");
            await viewer.signal({ kind: 'candidate', candidate: forwarder.first, sdp_mid: '0', sdp_m_line_index: 0 });
            return session;
        },
        /** What the forwarder has read of the call so far. */
        wire: async () => (await fetch(`/__forwarder/${forwarder.id}`)).json(),
        /** The camera's session with the viewer, once there is one. */
        peer: () => broadcaster.peers.get(viewer.session),
        /** The camera's own reading of that session. */
        reading: () => broadcaster.peers.get(viewer.session).read(),
        close() {
            broadcaster.endAll();
            viewer.close();
            source.stop();
            devices.close();
        },
    };
}

/** Whether this browser can encode H.264 at all (every browser a camera runs in can; some builds can't). */
const sendsH264 = () => (RTCRtpSender.getCapabilities('video')?.codecs ?? []).some((codec) => /h264/i.test(codec.mimeType));

test('sends nothing on a call that did not agree AES-GCM', async () => {
    const w = await world();
    try {
        const session = await w.watch();
        const end = await until(() => w.viewer.heard.find((signal) => signal.kind === 'bye') ?? (w.peer()?.locked ? 'locked' : null), 'the camera to refuse the call, or to take it', 25_000);
        if (end === 'locked') {
            // Two browsers that agree AES-GCM between themselves: none does today.
            const look = await w.viewer.look();
            note(`this browser agreed ${look.cipher} with itself, so there was nothing to refuse`);
            assert.ok(isGcm(look.cipher));
            return;
        }
        // The camera's own record of the call it turned away, from its connection's report.
        assert.equal(w.broadcaster.refused.length, 1);
        const refused = w.broadcaster.refused[0];
        note(`two ends in this browser agreed ${refused.cipher}; the camera encoded ${refused.framesEncoded} frames and sent ${refused.packetsOfSound} packets of sound, then ended the call`);
        assert.equal([refused.session, refused.viewer, refused.why], [session, w.viewerId, 'cipher']);
        assert.ok(refused.cipher && !isGcm(refused.cipher), 'the call was not on AES-GCM');
        assert.equal([refused.framesEncoded, refused.packetsOfSound], [0, 0], 'nothing of the room was encoded or sent');
        assert.equal([w.viewer.final?.video?.framesDecoded ?? 0, w.viewer.final?.video?.packetsReceived ?? 0, w.viewer.final?.audio?.packetsReceived ?? 0], [0, 0, 0], 'and nothing of it arrived');
        // And the wire agrees: no packet of picture or sound crossed from the camera.
        assert.equal((await w.wire()).rtp_from.a_to_b?.packets ?? 0, 0);
        assert.equal(end.reason, null, 'a bye without a reason');
        assert.equal(w.broadcaster.peers.size, 0);
        assert.equal(w.broadcaster.watchers(), []);
        assert.equal(w.watchersSeen.flat(), [], 'nobody ever counted as watching');
    } finally {
        w.close();
    }
});

test("offers as the apps' cameras do, sends nothing until play, then a picture and a tone at the step it's capped to", async () => {
    const w = await world({ terms: ANY_SUITE_FOR_TESTS });
    try {
        // ---- The offer ----
        const session = await w.watch({ warm: true });
        const offer = w.viewer.offer;
        assert.equal(w.viewer.offerSigned, true, "signed with the camera's signal key");
        const [video, audio, data] = codecsIn(offer);
        assert.equal([video.kind, audio.kind, data.kind], ['video', 'audio', 'application']);
        const names = [...new Set(video.codecs)];
        const expected = sendsH264() ? ['H264', 'VP8'] : ['VP8'];
        assert.equal(names.filter((name) => !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(name)), expected, 'H.264 first, VP8 after it, and no other codec');
        assert.equal(extensionsIn(offer).sort(), [...HEADER_EXTENSIONS].sort(), 'the three header extensions a call needs, and no other');
        assert.ok(!/audio-level|video-orientation|toffset|playout-delay|content-type|video-timing|color-space/.test(offer), 'nothing telling is offered');
        assert.equal(directionsIn(offer).slice(0, 2), [{ kind: 'video', direction: 'sendrecv' }, { kind: 'audio', direction: 'sendrecv' }]);
        assert.ok(/a=group:BUNDLE 0 1 2/.test(offer) && /a=fingerprint:sha-256 /.test(offer));
        const answer = await until(() => w.viewer.answer, "the viewer's answer");
        assert.ok(extensionsIn(answer).every((uri) => HEADER_EXTENSIONS.includes(uri)), 'the answer can only take what was offered');
        note(`the offer: ${names.join(', ')}; header extensions ${extensionsIn(offer).map((uri) => uri.split(/[:/]/).pop()).join(', ')}; left out ${w.peer().stoppedByApi ? "by the browser's own call" : 'by going over the offer'}`);

        // ---- A ready connection: connected, and nothing encoded ----
        const peer = await until(() => (w.peer()?.locked ? w.peer() : null), 'the connection to come up on its terms', 20_000);
        assert.equal([peer.hasConnected, peer.playing], [true, false]);
        await sleep(2_500);
        let reading = await w.reading();
        assert.equal([reading.video?.framesEncoded ?? 0, reading.video?.bytesSent ?? 0, reading.audio?.packetsSent ?? 0], [0, 0, 0], 'a ready connection encodes nothing, of picture or sound');
        let look = await w.viewer.look();
        assert.equal([look.state, look.video?.framesDecoded ?? 0, look.audio?.packetsReceived ?? 0], ['connected', 0, 0]);
        assert.equal(look.certificateIsTheSignedOne, true, "the far certificate is the one the camera's signed offer named");
        assert.equal(w.broadcaster.watchers(), [], "a ready session isn't someone watching");
        assert.equal(w.viewer.channel?.label, 'petcam');

        // ---- Play ----
        const played = performance.now();
        w.viewer.tell({ type: 'play' });
        await until(async () => ((await w.viewer.look()).video?.framesDecoded ?? 0) > 0, 'the first frame after play', 15_000, 20);
        const firstFrame = Math.round(performance.now() - played);
        await until(async () => ((await w.viewer.look()).video?.framesDecoded ?? 0) > 45, 'a second and more of picture', 15_000);
        look = await w.viewer.look();
        reading = await w.reading();
        assert.ok(/H264|VP8/i.test(look.video.codec), look.video.codec);
        assert.equal(/H264/i.test(look.video.codec), sendsH264(), 'H.264 where the browser encodes it');
        assert.equal(w.broadcaster.watchers().map((watcher) => [watcher.viewer, watcher.listening, watcher.video, watcher.tile]), [[w.viewerId, true, true, false]]);
        const toneRuns = w.devices.toneRuns;
        let heard = null;
        if (toneRuns) {
            // The sound that arrives is the tone that was made: its pitch, at a level that isn't silence.
            heard = await until(() => {
                const sound = w.viewer.hears();
                return sound && sound.db > -45 && Math.abs(sound.hz - TONE_HZ) < 30 ? sound : null;
            }, 'the tone to be heard at the far end', 10_000);
            assert.ok((await w.reading()).audio.packetsSent > 0);
            assert.ok((await w.viewer.look()).audio.packetsReceived > 0);
        }
        note(`first frame ${firstFrame} ms after play; ${look.video.codec} ${look.video.width}×${look.video.height}; encoder ${reading.video.encoder ?? 'unnamed'}; ${heard ? `the ${TONE_HZ} Hz tone arrived at ${Math.round(heard.hz)} Hz, ${Math.round(heard.db)} dB` : 'no sound: this browser keeps a made tone silent until someone taps the page'}`);

        // ---- What the camera tells the viewer of its link, every two seconds ----
        const stats = await until(() => w.viewer.told.find((message) => message.type === 'camera_stats'), "the camera's side of the link, on the data channel", 10_000);
        assert.ok(readPeerMessage(stats) !== null && LADDER.some((rung) => rung.name === stats.stats.step), `a step the apps know: ${stats.stats.step}`);

        // ---- The caps, through setParameters ----
        const parameters = () => peer.videoSender.getParameters().encodings[0];
        const sentSize = async () => {
            const video = (await w.reading()).video;
            return video?.frameHeight ? Math.min(video.frameHeight, video.frameWidth) : null;
        };
        // On a path with room to spare the picture climbs to what it captures: 720p at 30.
        await until(async () => peer.tuner.rung === 3 && (await sentSize()) === 720, 'the picture to reach 720p', 30_000, 250);
        assert.equal([parameters().maxBitrate, parameters().maxFramerate, parameters().scaleResolutionDownBy], [2_500_000, 30, 1]);
        // A viewer caps its own session: Low is 360p at 15, at once.
        w.viewer.tell({ type: 'cap', quality: 'low' });
        await until(() => peer.viewerCap === 'low' && peer.applied?.step === 0, 'the cap to be applied');
        assert.equal([parameters().active, parameters().maxBitrate, parameters().maxFramerate, parameters().scaleResolutionDownBy], [true, 450_000, 15, 2]);
        await until(async () => (await sentSize()) === 360, 'the encoder to follow down to 360p', 20_000, 250);
        // Frames a second, counted from what was encoded: the cap is 15.
        const encodedIn = async (ms) => {
            const before = (await w.reading()).video.framesEncoded;
            const from = performance.now();
            await sleep(ms);
            return (((await w.reading()).video.framesEncoded - before) * 1000) / (performance.now() - from);
        };
        let lowFps = await encodedIn(2_000);
        for (let tries = 0; tries < 4 && lowFps > 17; tries++) lowFps = await encodedIn(2_000);
        const low = (await w.reading()).video;
        // Not every browser holds an encoder to its frame rate: which do is worth knowing, and is noted, not assumed.
        note(lowFps <= 17 ? `under a cap of 15 frames a second it sent ${lowFps.toFixed(1)}` : `under a cap of 15 frames a second this browser still sent ${lowFps.toFixed(1)}: it scales the picture as asked, and doesn't slow it`);
        // A grid tile's cap stops at 540p30, and the picture climbs back to it.
        w.viewer.tell({ type: 'cap', quality: 'tile' });
        await until(async () => peer.tuner.rung === 2 && (await sentSize()) === 540, 'the picture to climb to 540p under a tile cap', 30_000, 250);
        assert.equal([parameters().maxBitrate, parameters().maxFramerate], [1_000_000, 30]);
        assert.ok(Math.abs(parameters().scaleResolutionDownBy - 720 / 540) < 0.001);
        assert.equal(w.broadcaster.watchers()[0].tile, true, "a tile isn't a live view");
        // A cap nobody here knows changes nothing.
        w.viewer.tell({ type: 'cap', quality: 'ultra' });
        await sleep(300);
        assert.equal(peer.viewerCap, 'tile');
        note(`caps: 720p at 2.5 Mbps; low → ${low.frameWidth}×${low.frameHeight}; tile → 540p`);

        // ---- Listen, video, pause ----
        w.viewer.tell({ type: 'cap', quality: 'auto' });
        const audioParameters = () => peer.audioSender.getParameters().encodings[0];
        w.viewer.tell({ type: 'listen', on: false });
        await until(() => audioParameters().active === false, "the sound to stop for a view that isn't listening");
        assert.equal(parameters().active, true);
        assert.equal(w.broadcaster.watchers()[0].listening, false);
        if (toneRuns) {
            await sleep(400);
            const before = (await w.reading()).audio.packetsSent;
            await sleep(1_000);
            assert.equal((await w.reading()).audio.packetsSent, before, 'no sound is sent to it');
        }
        w.viewer.tell({ type: 'listen' });
        await until(() => audioParameters().active === true, 'the sound to come back');
        // A viewer listening from its lock screen gets sound only.
        w.viewer.tell({ type: 'video', on: false });
        await until(() => parameters().active === false, 'the picture to stop');
        assert.equal([audioParameters().active, w.broadcaster.watchers()[0].video], [true, false]);
        await sleep(600);
        const paused = (await w.reading()).video;
        await sleep(1_000);
        assert.equal((await w.reading()).video.framesEncoded, paused.framesEncoded, 'no frame is encoded for it');
        w.viewer.tell({ type: 'video', on: true });
        await until(async () => (await w.reading()).video.framesEncoded > paused.framesEncoded + 10, 'the picture to come back', 10_000);
        assert.ok((await w.reading()).video.keyFramesEncoded > (paused.keyFramesEncoded ?? 0), 'starting with a keyframe');
        // Pause: back to a ready connection, and nobody watching.
        w.viewer.tell({ type: 'pause' });
        await until(() => parameters().active === false && audioParameters().active === false, 'everything to stop');
        assert.equal(w.broadcaster.watchers(), []);

        // ---- The end ----
        assert.equal(w.relay.dropped, [], 'nothing the camera sent was a frame the Worker would drop');
        w.broadcaster.endAll();
        await until(() => w.viewer.heard.find((signal) => signal.kind === 'bye'), "the camera's goodbye");
        assert.equal(w.viewer.heard.find((signal) => signal.kind === 'bye').reason, 'camera_stopped');
        assert.equal(w.viewer.unopened, 0);
        assert.ok(w.watchersSeen.length >= 2, 'the camera heard of each change in who is watching');
        assert.equal(session, w.viewer.session);
    } finally {
        w.close();
    }
});

test('keeps to three header extensions on the wire, where a relay could read them', async () => {
    const w = await world({ terms: ANY_SUITE_FOR_TESTS });
    try {
        // Both ends talk through a forwarder on this computer that reads what passes.
        const session = await w.watch();
        await until(async () => ((await w.viewer.look())?.video?.framesDecoded ?? 0) > 30, 'a second of picture through the forwarder', 30_000);
        if (w.devices.toneRuns) await until(async () => ((await w.viewer.look()).audio?.packetsReceived ?? 0) > 20, 'sound through the forwarder', 10_000);
        const seen = await w.wire();
        // The numbers the offer gave the three extensions it kept.
        const allowed = new Map();
        for (const line of w.viewer.offer.split(/\r?\n/)) {
            const match = /^a=extmap:(\d+)(?:\/\S+)?\s+(\S+)/.exec(line);
            if (match) allowed.set(match[1], match[2].split(/[:/]/).pop());
        }
        const fromCamera = seen.rtp_from.a_to_b;
        assert.ok(fromCamera && fromCamera.packets > 30 && fromCamera.with_extensions > 0, 'packets of the room crossed the forwarder');
        assert.equal(Object.keys(fromCamera.markers), ['bede'], 'one-byte extensions, as SRTP leaves them');
        const strangers = Object.keys(fromCamera.ids).filter((id) => !allowed.has(id));
        assert.equal(strangers, [], 'every extension on the wire is one of the three offered');
        assert.ok(seen.client_hello_srtp?.length > 0, "the hello's SRTP suites were read");
        const look = await w.viewer.look();
        note(`on the wire from the camera: ${fromCamera.packets} packets, extensions ${Object.keys(fromCamera.ids).map((id) => allowed.get(id)).join(', ')}; the hello offered ${seen.client_hello_srtp.join(', ')}; agreed ${look.cipher}, DTLS ${(seen.server_hello_versions ?? []).join('') === '0xfefc' ? '1.3' : seen.server_hello_versions}`);
        assert.equal(session, w.viewer.session);
    } finally {
        w.close();
    }
});

// What the Worker would list for a home with relay hours: a STUN server and a
// TURN one. Both point at this computer's own discard port, so nothing here
// reaches for a server anywhere.
const LISTED = [{ urls: ['stun:127.0.0.1:9', 'turn:127.0.0.1:9?transport=udp'], username: 'made-up', credential: 'made-up' }];

/** The addresses a connection was made with. @param {RTCPeerConnection} pc */
const serversOf = (pc) => pc.getConfiguration().iceServers.flatMap((server) => [server.urls].flat());

test('makes a session without the relay when the watch says so, and it plays on a direct path', async () => {
    const w = await world({ terms: ANY_SUITE_FOR_TESTS, iceServers: LISTED });
    try {
        const session = await w.watch({ warm: true, relay: false });
        // Its offer says so, as false, and is signed as any offer is.
        const offer = w.viewer.heard.find((signal) => signal.kind === 'offer');
        assert.equal([offer.relay, w.viewer.offerSigned], [false, true]);
        const peer = await until(() => (w.peer()?.locked ? w.peer() : null), 'the connection to come up on its terms', 20_000);
        assert.equal(peer.usesRelay, false);
        // Its connection has no TURN server at all, and no credentials; the STUN server stays.
        assert.equal(serversOf(peer.pc), ['stun:127.0.0.1:9']);
        assert.equal(peer.pc.getConfiguration().iceServers.some((server) => server.username || server.credential), false);
        const gathered = w.sent.filter((each) => each.session === session && each.payload.kind === 'candidate').map((each) => readCandidate(each.payload.candidate));
        assert.ok(gathered.length > 0 && gathered.every((candidate) => candidate && candidate.type !== 'relay'), 'it sent candidates, and none a relay');
        // The viewer trickles a relay candidate: it never reaches the connection, and its port is noted.
        await w.viewer.signal({ kind: 'candidate', candidate: 'candidate:9 1 udp 41885439 192.0.2.7 50000 typ relay raddr 0.0.0.0 rport 0 generation 0', sdp_mid: '0', sdp_m_line_index: 0 });
        await until(() => peer.relayPortsLeftOut.has(50000), 'the relay candidate to be left out');
        assert.ok(!/typ relay/.test(`${peer.pc.remoteDescription?.sdp}${peer.pc.currentRemoteDescription?.sdp}`));
        // Its path is direct, so it's a call like any other: nothing until play, then the picture.
        const before = await w.reading();
        assert.equal([before.video?.framesEncoded ?? 0, before.path?.relayed], [0, false]);
        w.viewer.tell({ type: 'play' });
        await until(async () => ((await w.viewer.look()).video?.framesDecoded ?? 0) > 15, 'the picture after play', 20_000);
        assert.equal([w.viewer.heard.some((signal) => signal.kind === 'bye'), w.broadcaster.peers.size, w.broadcaster.refused], [false, 1, []]);
        note(`without the relay: servers ${serversOf(peer.pc).join(', ')}; the path it picked is heard ${peer.ice ? "by the browser's own event" : "from the connection's report alone"}: ${JSON.stringify(peer.selectedPair)}`);

        // The same viewer asking with the relay gets a session with it, and an offer that says nothing of it.
        w.viewer.session = randomId();
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto', warm: true });
        const second = await until(() => w.viewer.heard.find((signal) => signal.kind === 'offer' && signal.session === w.viewer.session), 'an offer for a watch with the relay');
        const withIt = w.broadcaster.peers.get(w.viewer.session);
        assert.equal([second.relay, withIt.usesRelay, serversOf(withIt.pc).some(isRelayUrl)], [null, true, true]);
    } finally {
        w.close();
    }
});

test("ends a session made without the relay that a viewer's relay reaches all the same, and holds that viewer off the same way", async () => {
    const w = await world({ terms: ANY_SUITE_FOR_TESTS, iceServers: LISTED });
    const offers = () => w.sent.filter((each) => each.payload.kind === 'offer').length;
    const byes = () => w.viewer.heard.filter((signal) => signal.kind === 'bye');
    try {
        // A forwarder on this computer stands in for a relay the viewer holds. The viewer reaches the camera only through it, and never offers it as a direct candidate.
        const forwarder = await (await fetch('/__forwarder', { method: 'POST' })).json();
        w.viewer.only = forwarder.second;
        const session = await w.viewer.watch({ relay: false });
        await until(() => w.viewer.offer, "the camera's offer");
        const peer = await until(() => w.peer(), 'the session');
        // Word of the viewer's relay candidate: left out, its port noted.
        const relayPort = readCandidate(forwarder.first).port;
        await w.viewer.signal({ kind: 'candidate', candidate: forwarder.first.replace('typ host', 'typ relay raddr 0.0.0.0 rport 0'), sdp_mid: '0', sdp_m_line_index: 0 });
        await until(() => peer.relayPortsLeftOut.has(relayPort), 'the relay candidate to be left out');
        // The relay reaches the camera all the same, at the ports it listens on: before the camera has sent it anything.
        const ports = await until(() => {
            const found = w.sent.filter((each) => each.session === session && each.payload.kind === 'candidate').map((each) => readCandidate(each.payload.candidate)).filter((candidate) => candidate && candidate.port > 1023).map((candidate) => candidate.port);
            return found.length > 0 ? [...new Set(found)] : null;
        }, "the camera's own candidates");
        await sleep(500);
        await fetch(`/__forwarder/${forwarder.id}/reach?ports=${ports.join(',')}`, { method: 'POST' });
        // The camera's browser takes it as a candidate of its own finding, on the relay's port, and the session ends for it.
        const bye = await until(() => byes()[0], 'the camera to end the session for its path', 30_000);
        assert.equal([bye.reason, bye.session], ['relay_off', session]);
        note(`a relay left out reached the camera first: the path it was judged by, ${JSON.stringify(peer.selectedPair)}, with port ${relayPort} left out; heard ${peer.ice ? "by the browser's own event" : "from the connection's report"}`);
        assert.equal([peer.selectedPair?.remoteType, peer.selectedPair?.remotePort ?? relayPort], ['prflx', relayPort]);
        // It wasn't turned away for its terms, nobody counted as watching, and nothing of the room crossed the relay.
        assert.equal([w.broadcaster.refused, w.broadcaster.peers.size, w.watchersSeen.flat(), peer.locked], [[], 0, [], false]);
        const wire = await (await fetch(`/__forwarder/${forwarder.id}`)).json();
        assert.equal(wire.rtp_from.a_to_b?.packets ?? 0, 0, 'no packet of picture or sound went through it');

        // Asked the same way again: answered the same way, with nothing set up.
        const before = offers();
        w.viewer.session = randomId();
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto', relay: false });
        const second = await until(() => byes()[1], 'a second goodbye');
        assert.equal([second.reason, second.session, offers(), w.broadcaster.peers.size, w.broadcaster.starting.size], ['relay_off', w.viewer.session, before, 0, 0]);
        // Asking with the relay, it is set up as any session is: a page has no switch to say is off.
        w.viewer.session = randomId();
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto', warm: true });
        await until(() => offers() === before + 1, 'an offer for a watch with the relay');
        assert.equal([byes().length, w.broadcaster.peers.get(w.viewer.session).usesRelay], [2, true]);
    } finally {
        w.close();
    }
});

test('takes no answer whose signature does not hold', async () => {
    const w = await world({ terms: ANY_SUITE_FOR_TESTS });
    try {
        w.viewer.tamper.answerSig = b64url(new Uint8Array(32));
        await w.watch();
        const bye = await until(() => w.viewer.heard.find((signal) => signal.kind === 'bye'), 'the camera to turn the answer down');
        assert.equal(bye.reason, 'bad_signature');
        assert.equal(w.broadcaster.peers.size, 0);
        assert.equal(w.watchersSeen.flat(), []);
    } finally {
        w.close();
    }
});

test('starts nothing for a watch that is old, replayed, or not its own', async () => {
    const w = await world({ terms: ANY_SUITE_FOR_TESTS });
    const offers = () => w.sent.filter((s) => s.payload.kind === 'offer').length;
    try {
        // Sent three minutes ago: a watch the server played back.
        await w.viewer.watch({ sentAt: Date.now() - 180_000 });
        // Sealed with a key that isn't this camera's.
        const stranger = await KeySet.forCamera(randomBytes(32), 7);
        w.viewer.session = randomId();
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto' }, { keys: stranger });
        // Sealed for another camera, and handed to this one.
        w.viewer.session = randomId();
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto' }, { to: randomId() });
        // Under an epoch that isn't the camera's.
        const older = await KeySet.forCamera(randomBytes(32), 6);
        w.viewer.session = randomId();
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto' }, { keys: older });
        await sleep(1_200);
        await w.signals.settled();
        assert.equal([offers(), w.broadcaster.peers.size, w.broadcaster.starting.size], [0, 0, 0], 'none of them started a session');
        // A watch of its own, and fresh: one offer. The same session asked for again: nothing more.
        const session = await w.watch({ warm: true });
        await until(() => offers() === 1, 'an offer for a real watch');
        await w.viewer.signal({ kind: 'watch', audio: true, quality: 'auto', warm: true }, { session });
        await sleep(1_000);
        assert.equal(offers(), 1, 'a second watch for a session already started starts nothing');
        // A goodbye from a device that isn't the session's viewer ends nothing.
        w.broadcaster.bye(randomId(), session);
        assert.equal(w.broadcaster.peers.size, 1);
        await w.viewer.bye();
        await until(() => w.broadcaster.peers.size === 0, "the viewer's goodbye to end its session");
    } finally {
        w.close();
    }
});
