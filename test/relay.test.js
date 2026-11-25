// A session made without the relay (src/rtc/relay.js): the rules a camera
// holds one to, as the apps' cameras hold theirs (docs/API.md, Realtime,
// The Relay switch), and a camera's sessions following them with a
// connection that's a stand-in. test/rtc.browser.js runs the same on real
// connections.

import { CameraBroadcaster } from '../src/rtc/broadcaster.js';
import { CameraPeer } from '../src/rtc/peer.js';
import { RELAY_OFF_HOLD_MS, RelayOffHolds, isRelayUrl, keepsCandidate, pathRelays, readCandidate, withoutRelay, withoutRelayCandidates } from '../src/rtc/relay.js';
import { STUN_ONLY } from '../src/wire/frames.js';
import { BYE } from '../src/wire/signal.js';
import { FakeClock } from './lib/fakes.js';
import { assert, suite, test, until } from './lib/harness.js';

const HOST = 'candidate:1 1 udp 2122260223 192.0.2.10 54321 typ host generation 0 ufrag abcd network-id 1';
const REFLEXIVE = 'candidate:2 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.0.2.10 rport 54321 generation 0';
const RELAY = 'candidate:3 1 udp 41885695 198.51.100.4 50123 typ relay raddr 203.0.113.7 rport 61000 generation 0 ufrag abcd';
const RELAY_V6 = 'candidate:4 1 udp 41885439 2001:db8::4 50999 typ relay raddr 2001:db8::7 rport 61001';
const TCP = 'candidate:5 1 tcp 1518280447 192.0.2.10 9 typ host tcptype active';

suite('without the relay');

test('leaves only the STUN servers, and no credentials', () => {
    const listed = [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'user', credential: 'secret' }];
    const kept = withoutRelay(listed);
    assert.equal(kept, [{ urls: ['stun:stun.cloudflare.com:3478'] }], "credentials are the relay's");
    assert.equal(listed[0].urls.length, 4, 'what it was handed is as it was');
    const stun = { urls: ['stun:stun.example:3478'] };
    const turn = { urls: 'turn:192.168.1.20:3478?transport=udp', username: 'petcam', credential: 'secret' };
    assert.equal(withoutRelay([stun, turn]), [{ urls: ['stun:stun.example:3478'] }]);
    // Left with nothing, the STUN server a call falls back on: a direct path across the internet can still be found.
    const fallback = STUN_ONLY.map((server) => ({ urls: [...server.urls] }));
    assert.equal(withoutRelay([turn]), fallback);
    assert.equal(withoutRelay([]), fallback);
    assert.equal([isRelayUrl('turn:turn.example:3478'), isRelayUrl('turns:turn.example:5349?transport=tcp'), isRelayUrl('TURN:turn.example:3478')], [true, true, true]);
    assert.equal([isRelayUrl('stun:stun.example:3478'), isRelayUrl('stuns:stun.example:5349'), isRelayUrl('turnip.example'), isRelayUrl(''), isRelayUrl(null)], [false, false, false, false, false]);
});

test("reads a candidate for its type and its port, and keeps every one of a viewer's but a relay's", () => {
    assert.equal([readCandidate(HOST), readCandidate(REFLEXIVE), readCandidate(RELAY), readCandidate(RELAY_V6), readCandidate(TCP)],
        [{ type: 'host', port: 54321 }, { type: 'srflx', port: 61000 }, { type: 'relay', port: 50123 }, { type: 'relay', port: 50999 }, { type: 'host', port: 9 }]);
    assert.equal(readCandidate(`a=${RELAY}\r`), { type: 'relay', port: 50123 }, 'as a line of a description');
    assert.equal(readCandidate(RELAY.replace('typ relay', 'typ RELAY')).type, 'relay');
    for (const unreadable of ['', 'candidate:1', 'candidate:1 1 udp 1 192.0.2.1 9 host', 'candidate:1 1 udp 1 192.0.2.1 port typ host', 'candidate:1 1 udp 1 192.0.2.1 70000 typ host', 'a=mid:0', null, 7]) assert.equal(readCandidate(unreadable), null, String(unreadable));
    assert.equal([keepsCandidate(HOST), keepsCandidate(REFLEXIVE), keepsCandidate(TCP)], [true, true, true]);
    assert.equal([keepsCandidate(RELAY), keepsCandidate(RELAY_V6), keepsCandidate('candidate:1'), keepsCandidate('')], [false, false, false, false], "one it can't read might be anything");
});

test('takes the relay candidates out of an answer and nothing else, byte for byte', () => {
    const lines = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', `a=${HOST}`, `a=${RELAY}`, `a=${REFLEXIVE}`, `a=${RELAY_V6}`, 'a=end-of-candidates', 'a=fingerprint:sha-256 AB:CD'];
    const sdp = `${lines.join('\r\n')}\r\n`;
    const without = withoutRelayCandidates(sdp);
    assert.equal([...without.ports].sort(), [50123, 50999]);
    assert.equal(without.sdp, `${lines.filter((line) => !line.includes('typ relay')).join('\r\n')}\r\n`);
    assert.ok(without.sdp.includes(`a=${HOST}\r\n`) && without.sdp.includes('a=fingerprint:sha-256 AB:CD\r\n'), 'what the signature covered is otherwise as it was');
    // The apps' own answers carry no candidates: nothing changes.
    const plain = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    assert.equal([withoutRelayCandidates(plain).sdp, withoutRelayCandidates(plain).ports.size], [plain, 0]);
    assert.equal(withoutRelayCandidates(`v=0\na=${RELAY}\na=${HOST}\n`).sdp, `v=0\na=${HOST}\n`, 'with bare newlines too');
});

test('sees a path through a relay that was left out', () => {
    const leftOut = new Set([50123]);
    const path = (localType, remoteType, remotePort) => ({ localType, remoteType, remotePort });
    assert.equal(pathRelays(path('host', 'host', 54321), leftOut), false, 'the same network');
    assert.equal(pathRelays(path('srflx', 'srflx', 61000), leftOut), false, "through each side's router");
    assert.equal(pathRelays(path('relay', 'host', 54321), new Set()), true, "this end's own relay");
    assert.equal(pathRelays(path('host', 'relay', 50123), new Set()), true, "the other end's, taken");
    assert.equal(pathRelays(path('host', 'prflx', 50123), leftOut), true, 'the relay left out reached this end first');
    assert.equal(pathRelays(path('host', 'prflx', 40000), leftOut), false, 'a router that changes ports is still direct');
    assert.equal(pathRelays(path('host', 'prflx', 50123), new Set()), false, 'nothing was left out');
    assert.equal(pathRelays(path('host', 'prflx', null), leftOut), true, 'no port to go by: not chanced');
    assert.equal(pathRelays(path('host', 'prflx', 0), leftOut), true);
    assert.equal(pathRelays(path('prflx', 'host', 54321), leftOut), false, "this end's own address, as the other saw it");
    assert.equal(pathRelays(path(null, null, null), leftOut), false, 'no path yet');
});

test('holds a viewer it just ended for the relay off for half a minute', () => {
    const holds = new RelayOffHolds();
    const now = 1_767_225_600_000;
    assert.equal(holds.holds('a-phone', now), false);
    holds.ended('a-phone', now);
    assert.equal([holds.holds('a-phone', now), holds.holds('a-phone', now + RELAY_OFF_HOLD_MS - 1), holds.holds('another-phone', now)], [true, true, false]);
    assert.equal(holds.holds('a-phone', now + RELAY_OFF_HOLD_MS), false, 'after half a minute it may ask again');
    assert.equal([RELAY_OFF_HOLD_MS, holds.until.size], [30_000, 0]);
});

// ---- A camera's sessions, on a connection that's a stand-in -----------------

/** A stand-in for a browser's connection: it keeps what it was made with and handed, and reports the path it's told to. */
function standIn() {
    const made = [];
    class Connection {
        constructor(configuration) {
            this.configuration = configuration;
            this.added = [];
            this.remote = null;
            this.connectionState = 'new';
            /** What `getStats` reports: a test sets it. */
            this.report = [];
            this.ice = { pair: null, onselectedcandidatepairchange: null, getSelectedCandidatePair: () => this.ice.pair };
            made.push(this);
        }

        addTransceiver(kind) {
            const sender = { transport: null, parameters: { encodings: [{ active: false }] }, getParameters: () => sender.parameters, setParameters: async (parameters) => void (sender.parameters = parameters), replaceTrack: async () => {} };
            if (kind === 'video' || kind?.kind === 'video') this.videoSender = sender;
            return { sender, setCodecPreferences() {} };
        }

        createDataChannel(label) {
            this.channel = { label, readyState: 'open', onmessage: null, sent: [], send: (text) => this.channel.sent.push(text), close() {} };
            return this.channel;
        }

        async createOffer() {
            return { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
        }

        async setLocalDescription() {
            // A sender has its transport from here on.
            this.videoSender.transport = { iceTransport: this.ice };
        }

        async setRemoteDescription(description) {
            this.remote = description;
        }

        async addIceCandidate(candidate) {
            this.added.push(candidate.candidate);
        }

        async getStats() {
            return { forEach: (visit) => this.report.forEach(visit) };
        }

        /** The browser picks a path, and says so. */
        pick(local, remote) {
            this.ice.pair = { local, remote };
            this.ice.onselectedcandidatepairchange?.();
        }

        close() {
            this.connectionState = 'closed';
        }
    }
    class Stream {}
    return { made, rtc: /** @type {any} */ ({ RTCPeerConnection: Connection, RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) }, MediaStream: Stream }) };
}

/** A report of a connected call, AES-GCM with the signed certificate, on the path given. */
const reportOf = (localType, remoteType, remotePort) => [
    { id: 'T', type: 'transport', dtlsState: 'connected', srtpCipher: 'SRTP_AEAD_AES_256_GCM', tlsVersion: 'FEFC', remoteCertificateId: 'C', selectedCandidatePairId: 'P' },
    { id: 'C', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: 'AB:CD' },
    { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: localType },
    { id: 'R', type: 'remote-candidate', candidateType: remoteType, ...(remotePort === null ? {} : { port: remotePort }) },
];
const ANSWER = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fingerprint:sha-256 AB:CD\r\na=${HOST}\r\na=${RELAY}\r\n`;
const SERVERS = [{ urls: ['stun:stun.example:3478', 'turn:turn.example:3478?transport=udp'], username: 'user', credential: 'secret' }];

/** A camera's sessions over stand-in connections. @param {{ iceServers?: RTCIceServer[] }} [how] */
function sessions(how = {}) {
    const clock = new FakeClock();
    const { made, rtc } = standIn();
    const sent = [];
    const broadcaster = new CameraBroadcaster({
        tracks: () => ({ video: null, audio: null, shortSide: 720 }), iceServers: async () => how.iceServers ?? SERVERS,
        send: (viewer, session, payload) => sent.push({ viewer, session, payload }), rtc, clock: { ...clock, at: () => clock.now() / 1000 },
    });
    return { clock, made, sent, broadcaster, offers: () => sent.filter((each) => each.payload.kind === 'offer'), byes: () => sent.filter((each) => each.payload.kind === 'bye') };
}

const TERMS = { audio: true, quality: 'auto', warm: true };

test('makes a session with the relay as ever, and says nothing of it', async () => {
    const s = sessions();
    await s.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, relay: true }, 'Kitchen iPad');
    const peer = s.broadcaster.peers.get('session-1');
    assert.equal([peer.usesRelay, s.made[0].configuration.iceServers], [true, SERVERS]);
    assert.equal(s.offers().map((offer) => Object.keys(offer.payload)), [['kind', 'sdp']], 'no `relay` in its offer, and never true');
    // The viewer's relay candidates are taken, in its answer and trickled, and a relayed path is the plan's to cap and count, not a reason to end.
    await s.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    await s.broadcaster.candidate('viewer-1', 'session-1', { candidate: RELAY_V6, sdpMid: '0', sdpMLineIndex: 0 });
    assert.equal([s.made[0].remote.sdp, s.made[0].added], [ANSWER, [RELAY_V6]]);
    s.made[0].pick({ type: 'host', port: 54321 }, { type: 'relay', port: 50123 });
    assert.equal([s.byes(), s.broadcaster.peers.size, peer.ice], [[], 1, null]);
    // A watch that leaves `relay` out is the same.
    await s.broadcaster.watch('viewer-1', 'session-2', TERMS);
    assert.equal(s.broadcaster.peers.get('session-2').usesRelay, true);
});

test("makes one without it when the watch says so: no TURN server, `relay: false` in its offer, none of the viewer's relay candidates", async () => {
    const s = sessions();
    await s.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, relay: false });
    const peer = s.broadcaster.peers.get('session-1');
    const connection = s.made[0];
    assert.equal(peer.usesRelay, false);
    assert.equal(connection.configuration.iceServers, [{ urls: ['stun:stun.example:3478'] }], 'the STUN server stays, the TURN one and its credentials go');
    assert.equal(s.offers().map((offer) => [Object.keys(offer.payload), offer.payload.relay]), [[['kind', 'sdp', 'relay'], false]]);
    // What it gathers itself: with no TURN server there's no relay candidate, and one that turned up would never be sent.
    connection.onicecandidate({ candidate: { candidate: HOST, sdpMid: '0', sdpMLineIndex: 0 } });
    connection.onicecandidate({ candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } });
    assert.equal(s.sent.filter((each) => each.payload.kind === 'candidate').map((each) => each.payload.candidate), [HOST]);
    // The viewer's: taken out of its answer (after its signature was checked, by whoever holds the keys), and left out as they trickle.
    await s.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    assert.ok(!connection.remote.sdp.includes('typ relay') && connection.remote.sdp.includes(`a=${HOST}\r\n`) && connection.remote.sdp.includes('a=fingerprint:sha-256 AB:CD'));
    assert.equal(peer.signedFingerprints, new Set(['sha-256 AB:CD']));
    for (const candidate of [REFLEXIVE, RELAY_V6, 'candidate:1', TCP]) await s.broadcaster.candidate('viewer-1', 'session-1', { candidate, sdpMid: '0', sdpMLineIndex: 0 });
    assert.equal(connection.added, [REFLEXIVE, TCP], "a relay's, and one it can't read, never reach the connection");
    assert.equal([...peer.relayPortsLeftOut].sort(), [50123, 50999]);
    assert.equal([s.byes(), s.broadcaster.peers.size], [[], 1]);
});

test('ends one whose path is relayed all the same, the moment the browser picks it, and holds its viewer off the same way', async () => {
    const s = sessions();
    await s.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, relay: false });
    const peer = s.broadcaster.peers.get('session-1');
    const connection = s.made[0];
    await s.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    assert.ok(peer.ice, "it hears of the browser's own pick");
    // A direct path, and one a router gave another port: nothing ends.
    connection.pick({ type: 'host', port: 54321 }, { type: 'host', port: 54321 });
    connection.pick({ type: 'host', port: 54321 }, { type: 'prflx', port: 40000 });
    assert.equal(s.byes(), []);
    // The viewer's relay, left out of its answer, reaches the camera first: the browser takes it as a candidate of its own finding, on the relay's port.
    connection.pick({ type: 'host', port: 54321 }, { type: 'prflx', port: 50123 });
    assert.equal(s.byes().map((bye) => [bye.session, bye.payload]), [['session-1', { kind: 'bye', reason: BYE.relayOff }]]);
    assert.equal([s.broadcaster.peers.size, connection.connectionState], [0, 'closed']);
    // More than one look can find it: it is said once.
    connection.pick({ type: 'host', port: 54321 }, { type: 'prflx', port: 50123 });
    assert.equal(s.byes().length, 1);

    // Asked the same way again within half a minute: answered the same way, with nothing set up.
    const made = s.made.length;
    await s.broadcaster.watch('viewer-1', 'session-2', { ...TERMS, relay: false });
    assert.equal([s.byes().at(-1).session, s.byes().at(-1).payload.reason, s.made.length, s.offers().length, s.broadcaster.peers.size], ['session-2', 'relay_off', made, 1, 0]);
    // Another viewer isn't held, and nor is this one once it no longer asks to go without the relay: a page has no switch to say is off.
    await s.broadcaster.watch('viewer-2', 'session-3', { ...TERMS, relay: false });
    await s.broadcaster.watch('viewer-1', 'session-4', TERMS);
    assert.equal([s.offers().length, s.byes().length, s.broadcaster.peers.get('session-4').usesRelay], [3, 2, true]);
    // Half a minute on, it may ask without the relay again.
    await s.clock.advance(RELAY_OFF_HOLD_MS);
    await s.broadcaster.watch('viewer-1', 'session-5', { ...TERMS, relay: false });
    assert.equal([s.offers().length, s.byes().filter((bye) => bye.payload.reason === 'relay_off').length], [4, 2]);
    s.broadcaster.endAll();
});

test('judges the path again as each relay candidate is left out, and by the report where the browser says no more', async () => {
    // Word of a relay candidate can come after the relay's first packet: the path already picked is judged again by its port.
    const late = sessions();
    await late.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, relay: false });
    await late.broadcaster.answer('viewer-1', 'session-1', ANSWER.replace(`a=${RELAY}\r\n`, ''));
    late.made[0].pick({ type: 'host', port: 54321 }, { type: 'prflx', port: 50999 });
    assert.equal(late.byes(), [], 'nothing was left out yet');
    await late.broadcaster.candidate('viewer-1', 'session-1', { candidate: RELAY_V6, sdpMid: '0', sdpMLineIndex: 0 });
    assert.equal(late.byes().map((bye) => bye.payload.reason), ['relay_off']);

    // A browser with no event for the path it picks: its connection's own report is read as it connects, before anything is encoded.
    const byReport = sessions();
    await byReport.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, warm: false, relay: false });
    const peer = byReport.broadcaster.peers.get('session-1');
    const connection = byReport.made[0];
    connection.ice.getSelectedCandidatePair = undefined;
    peer.ice.onselectedcandidatepairchange = null;
    await byReport.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    connection.report = reportOf('host', 'prflx', 50123);
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    await until(() => byReport.byes().length === 1, 'the session to end by its report');
    assert.equal([byReport.byes()[0].payload.reason, peer.locked, connection.videoSender.parameters.encodings[0].active, byReport.broadcaster.refused], ['relay_off', false, false, []]);

    // The same report on a session with the relay: it locks and plays, and the relay is the plan's to count.
    const withIt = sessions();
    await withIt.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, warm: false });
    await withIt.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    withIt.made[0].report = reportOf('relay', 'host', 54321);
    withIt.made[0].connectionState = 'connected';
    withIt.made[0].onconnectionstatechange();
    await until(() => withIt.broadcaster.peers.get('session-1')?.locked, 'the session with the relay to lock');
    assert.equal(withIt.byes(), []);

    // A direct path with no port said for a candidate the browser found itself, and a relay candidate left out: not chanced.
    const noPort = sessions();
    await noPort.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, relay: false });
    await noPort.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    noPort.made[0].pick({ type: 'host', port: 54321 }, { type: 'prflx' });
    assert.equal(noPort.byes().map((bye) => bye.payload.reason), ['relay_off']);
    for (const each of [late, byReport, withIt, noPort]) each.broadcaster.endAll();
});

test('a session without the relay that plays looks at its path again first', async () => {
    const s = sessions();
    await s.broadcaster.watch('viewer-1', 'session-1', { ...TERMS, relay: false });
    const peer = s.broadcaster.peers.get('session-1');
    const connection = s.made[0];
    // No event in this browser: the report is all there is.
    peer.ice.onselectedcandidatepairchange = null;
    peer.ice = null;
    await s.broadcaster.answer('viewer-1', 'session-1', ANSWER);
    connection.report = reportOf('host', 'host', 54321);
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    await until(() => peer.locked, 'a ready session on a direct path to lock');
    assert.equal(connection.videoSender.parameters.encodings[0].active, false, 'ready: nothing is encoded');
    // While it waited, the path moved onto the viewer's relay. Play: the path is read before the picture is turned on, and the session ends instead.
    connection.report = reportOf('host', 'prflx', 50123);
    connection.channel.onmessage({ data: JSON.stringify({ type: 'play' }) });
    await until(() => s.byes().length === 1, 'the session to end at play');
    await peer.writing;
    assert.equal([s.byes()[0].payload.reason, connection.videoSender.parameters.encodings[0].active], ['relay_off', false], 'no frame was ever turned on for it');
    assert.ok(peer instanceof CameraPeer);
});
