// The parts of the sending half that need no browser: what's read from and
// taken out of an offer, the ladder and its caps, the tuner that picks a
// step, and what a connection's report is read as.

import { CameraBroadcaster } from '../src/rtc/broadcaster.js';
import { CAMERA_CAP, CAPS, LADDER, ceilingOf, highestStep, isTile, pixelRate, planCap, stepWithin, topOf } from '../src/rtc/ladder.js';
import { codecsIn, directionsIn, extensionsIn, fingerprintsIn, withOnlyExtensions } from '../src/rtc/sdp.js';
import { handshakeName, readingOf } from '../src/rtc/stats.js';
import { HEADER_EXTENSIONS, TERMS, VIDEO_CODECS, isGcm } from '../src/rtc/terms.js';
import { StreamTuner } from '../src/rtc/tuner.js';
import { QUALITIES } from '../src/wire/peer.js';
import { FakeClock } from './lib/fakes.js';
import { assert, suite, test } from './lib/harness.js';

/** An offer as a browser writes one, cut to what's read of it. */
const OFFER = [
    'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2', 'a=extmap-allow-mixed',
    'm=video 9 UDP/TLS/RTP/SAVPF 102 103 96 97 98',
    'a=fingerprint:sha-256 48:04:43:e8:00:38:14:30:9C:B4:24:9C:D8:00:25:74:4C:20:A8:E6:67:33:57:69:B5:22:E5:4A:DE:DF:B7:DA',
    'a=setup:actpass', 'a=mid:0',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:toffset',
    'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=extmap:3 urn:3gpp:video-orientation',
    'a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
    'a=extmap:9 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=extmap:10/sendonly urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
    'a=sendrecv', 'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=rtpmap:98 red/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'a=fingerprint:sha-256 48:04:43:e8:00:38:14:30:9C:B4:24:9C:D8:00:25:74:4C:20:A8:E6:67:33:57:69:B5:22:E5:4A:DE:DF:B7:DA',
    'a=mid:1',
    'a=extmap:14 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=extmap:9 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=recvonly', 'a=rtpmap:111 opus/48000/2', 'a=rtpmap:63 red/48000/2',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:2', 'a=sctp-port:5000', '',
].join('\r\n');

suite('an offer');

test('keeps only the header extensions a call needs, and nothing else changes', () => {
    assert.equal(extensionsIn(OFFER).length, 8);
    const kept = withOnlyExtensions(OFFER, HEADER_EXTENSIONS);
    assert.equal(extensionsIn(kept).sort(), [...HEADER_EXTENSIONS].sort());
    assert.ok(!/audio-level|toffset|video-orientation|playout-delay|rtp-stream-id/.test(kept), 'nothing telling is left');
    assert.ok(kept.includes('a=extmap-allow-mixed'), "that line is no extension, and stays");
    const removed = OFFER.split('\r\n').filter((line) => !kept.split('\r\n').includes(line));
    assert.equal(removed.length, 5);
    assert.ok(removed.every((line) => line.startsWith('a=extmap:')), 'only extension lines went');
    assert.ok(kept.endsWith('\r\n') && !kept.includes('\n\n'), 'line ends as they were');
    assert.equal(withOnlyExtensions(kept, HEADER_EXTENSIONS), kept, 'going over it again changes nothing');
    assert.equal(withOnlyExtensions(OFFER.replace(/\r\n/g, '\n'), HEADER_EXTENSIONS), kept.replace(/\r\n/g, '\n'));
    assert.equal(HEADER_EXTENSIONS.length, 3);
});

test('is read for its fingerprints, its codecs and which way each part flows', () => {
    assert.equal(fingerprintsIn(OFFER), new Set(['sha-256 48:04:43:E8:00:38:14:30:9C:B4:24:9C:D8:00:25:74:4C:20:A8:E6:67:33:57:69:B5:22:E5:4A:DE:DF:B7:DA']));
    assert.equal(fingerprintsIn('v=0\r\n'), new Set());
    assert.equal(codecsIn(OFFER), [{ kind: 'video', codecs: ['H264', 'rtx', 'VP8', 'rtx', 'red'] }, { kind: 'audio', codecs: ['opus', 'red'] }, { kind: 'application', codecs: [] }]);
    assert.equal(directionsIn(OFFER), [{ kind: 'video', direction: 'sendrecv' }, { kind: 'audio', direction: 'recvonly' }, { kind: 'application', direction: null }]);
    assert.equal(VIDEO_CODECS, ['video/H264', 'video/VP8']);
});

suite('the terms');

test('take AES-GCM and nothing else', () => {
    for (const cipher of ['SRTP_AEAD_AES_256_GCM', 'SRTP_AEAD_AES_128_GCM', 'AEAD_AES_256_GCM', 'AEAD_AES_128_GCM']) assert.ok(isGcm(cipher), cipher);
    for (const cipher of ['SRTP_AES128_CM_HMAC_SHA1_80', 'AES_CM_128_HMAC_SHA1_80', 'SRTP_AES128_CM_HMAC_SHA1_32', '', null, undefined, 'AEAD_AES_256_GCM and more', 8]) assert.ok(!isGcm(cipher), String(cipher));
    assert.equal(TERMS.srtp, isGcm);
    assert.ok(Object.isFrozen(TERMS), "the page's terms can't be changed from outside");
});

suite('the ladder');

test("is the apps' own, step for step and cap for cap", () => {
    assert.equal(LADDER.map((rung) => rung.name), ['360p15', '360p30', '540p30', '720p30', '720p60', '1080p30', '1080p60']);
    assert.equal(LADDER.map((rung) => rung.minBitrate), [0, 300_000, 700_000, 1_200_000, 1_800_000, 2_500_000, 3_500_000]);
    assert.equal(Object.keys(CAPS).sort(), [...QUALITIES].sort(), 'a cap for every word a viewer may send');
    assert.equal(QUALITIES.map((cap) => [CAPS[cap].top, CAPS[cap].maxBitrate]), [[6, 5_000_000], [6, 5_000_000], [4, 2_500_000], [0, 450_000], [2, 1_000_000], [1, 600_000]]);
    assert.equal([planCap(1080), planCap(720), planCap(540), planCap(360)], ['auto', 'medium', 'tile', 'tile_small']);
    assert.equal(CAMERA_CAP, 'medium');
    assert.equal([isTile('tile'), isTile('tile_small'), isTile('low'), isTile('auto')], [true, true, false, false]);
    // As Swift's whole-number arithmetic has it.
    assert.equal([pixelRate(LADDER[0]), pixelRate(LADDER[3]), pixelRate(LADDER[6])], [3_456_000, 27_648_000, 124_416_000]);
    assert.equal([topOf(['auto', 'medium', 'auto']), topOf(['low', 'medium']), ceilingOf(['auto', 'medium', 'tile'])], [4, 0, 1_000_000]);
    // A page captures 30 frames a second: under its own cap the top is 720p30.
    assert.equal(stepWithin(topOf(['auto', CAMERA_CAP, 'auto']), 30), 3);
    assert.equal([highestStep(5_000_000, 1, 6, 30), highestStep(5_000_000, 1, 6, 60), highestStep(1_300_000, 1.25, 6, 30), highestStep(0, 1, 6, 30)], [5, 6, 2, 0]);
});

suite('the tuner');

/** A reading with what the tuner looks at. */
function reading(over = {}) {
    return {
        transport: null, path: { localType: 'host', remoteType: 'host', relayed: false, availableOutgoingBitrate: 'bandwidth' in over ? over.bandwidth : 4_000_000, roundTripTime: 0.01 },
        video: {
            active: true, codec: 'video/H264', targetBitrate: over.target === undefined ? 2_500_000 : over.target, framesEncoded: over.frames ?? 0, keyFramesEncoded: 1, totalEncodeTime: over.encodeTime ?? 0,
            packetsSent: over.packets ?? 0, bytesSent: 0, totalPacketSendDelay: over.sendDelay ?? 0, frameWidth: over.width ?? 1280, frameHeight: over.height ?? 720,
            framesPerSecond: over.fps === undefined ? 30 : over.fps, limitation: over.limitation ?? 'none', encoder: over.encoder ?? null,
        },
        audio: null, fractionLost: over.loss ?? 0, microphoneSeconds: over.microphone ?? null,
    };
}

test('starts mid-ladder and climbs after two good readings, never past what the page captures', () => {
    const tuner = new StreamTuner(topOf(['auto', CAMERA_CAP, 'auto']));
    assert.equal([tuner.top, tuner.rung], [4, 2]);
    assert.equal(tuner.update(reading({ height: 540, width: 960 }), { at: 0, maxFps: 30 }).step, '540p30', 'one good reading is not enough');
    assert.equal(tuner.update(reading({ height: 540, width: 960 }), { at: 2, maxFps: 30 }).step, '720p30');
    for (let i = 2; i < 8; i++) assert.equal(tuner.update(reading(), { at: i * 2, maxFps: 30 }).step, '720p30', 'a 60 fps step is never picked while capture runs at 30');
    // The same link with a capture at 60 would go on up, as an app's camera does.
    assert.equal(new StreamTuner(6).rung, 2);
    const fast = new StreamTuner(4);
    fast.update(reading({ target: 5_000_000 }), { at: 0, maxFps: 60 });
    assert.equal(fast.update(reading({ target: 5_000_000 }), { at: 2, maxFps: 60 }).step, '720p60');
});

test('steps down at once when the link falls short, loses packets or queues them', () => {
    const tuner = new StreamTuner(4);
    tuner.rung = 3;
    assert.equal(tuner.update(reading({ target: 800_000 }), { at: 0, maxFps: 30 }).step, '540p30', 'the step the bitrate pays for');
    tuner.rung = 3;
    assert.equal(tuner.update(reading({ loss: 0.08 }), { at: 2, maxFps: 30 }).step, '540p30', 'loss over 5%: one step under what fits');
    tuner.rung = 3;
    tuner.update(reading({ packets: 1000, sendDelay: 10 }), { at: 4, maxFps: 30 });
    const queued = tuner.update(reading({ packets: 1100, sendDelay: 20 }), { at: 6, maxFps: 30 });
    assert.equal([queued.step, Math.round(queued.sendQueueMs)], ['540p30', 100], 'a send queue over 60 ms');
    // With nothing to go on, the lowest step.
    assert.equal(new StreamTuner(4).update(reading({ target: null, bandwidth: null }), { at: 0, maxFps: 30 }).step, '360p15');
    // A cap that comes down takes the step with it.
    const capped = new StreamTuner(4);
    capped.rung = 3;
    capped.top = topOf(['low', CAMERA_CAP]);
    assert.equal([capped.rung, capped.update(reading(), { at: 0, maxFps: 30 }).step], [0, '360p15']);
});

test("goes by what was sent, and takes the browser's word for why only then", () => {
    // Safari said "bandwidth" every minute of an evening while the picture went out whole.
    const whole = new StreamTuner(4);
    whole.rung = 3;
    for (let i = 0; i < 5; i++) assert.equal(whole.update(reading({ limitation: 'bandwidth' }), { at: i * 2, maxFps: 30 }).step, '720p30');
    for (let i = 5; i < 10; i++) assert.equal(whole.update(reading({ limitation: 'cpu' }), { at: i * 2, maxFps: 30 }).step, '720p30', 'the processor named, with nothing short of the step');
    // The processor named, and the picture really short of its step: down by pixels a second, on the second reading.
    const short = new StreamTuner(4);
    short.rung = 3;
    assert.equal(short.update(reading({ limitation: 'cpu', fps: 17 }), { at: 0, maxFps: 30 }).step, '720p30');
    assert.equal(short.update(reading({ limitation: 'cpu', fps: 17 }), { at: 2, maxFps: 30 }).step, '540p30');
    const small = new StreamTuner(4);
    small.rung = 3;
    small.update(reading({ limitation: 'cpu', width: 960, height: 540 }), { at: 0, maxFps: 30 });
    assert.equal(small.update(reading({ limitation: 'cpu', width: 960, height: 540 }), { at: 2, maxFps: 30 }).step, '540p30', 'a picture the encoder scaled down itself');
});

test('tells the viewer what it measured, and leaves out what it could not', () => {
    const tuner = new StreamTuner(4);
    const first = tuner.update(reading({ frames: 0, encodeTime: 0, microphone: 1, fps: null }), { at: 10, maxFps: 30 });
    assert.equal([first.fps, first.encodeMs, first.sendQueueMs, first.micPercent, first.targetKbps, first.bandwidthKbps], [null, null, null, null, 2500, 4000]);
    const next = tuner.update(reading({ frames: 60, encodeTime: 0.24, packets: 500, sendDelay: 1, microphone: 3, fps: null, encoder: 'VideoToolbox' }), { at: 12, maxFps: 30 });
    assert.equal([next.fps, Math.round(next.encodeMs * 10) / 10, next.sendQueueMs, next.micPercent, next.encoder, next.width, next.height], [30, 4, 2, 100, 'VideoToolbox', 1280, 720]);
});

suite("a connection's report");

test('is read alike whichever browser wrote it, with null for what one leaves out', () => {
    const stats = [
        { id: 'T', type: 'transport', dtlsState: 'connected', srtpCipher: 'SRTP_AEAD_AES_256_GCM', tlsVersion: 'FEFC', dtlsCipher: 'TLS_AES_128_GCM_SHA256', remoteCertificateId: 'C', selectedCandidatePairId: 'P' },
        { id: 'C', type: 'certificate', fingerprintAlgorithm: 'SHA-256', fingerprint: '2c:38:63:48' },
        { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R', availableOutgoingBitrate: 6_004_000, currentRoundTripTime: 0.002 },
        { id: 'L', type: 'local-candidate', candidateType: 'relay' },
        { id: 'R', type: 'remote-candidate', candidateType: 'host', port: 50123 },
        { id: 'K', type: 'codec', mimeType: 'video/H264' },
        { id: 'V', type: 'outbound-rtp', kind: 'video', codecId: 'K', active: true, targetBitrate: 2_500_000, framesEncoded: 1424, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, qualityLimitationReason: 'none', packetsSent: 5363, bytesSent: 5_400_580 },
        { id: 'A', type: 'outbound-rtp', kind: 'audio', packetsSent: 2699, bytesSent: 218_673 },
        { id: 'F', type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.01 },
        { id: 'M', type: 'media-source', kind: 'audio', totalSamplesDuration: 54.2 },
    ];
    const read = readingOf({ forEach: (visit) => stats.forEach(visit) });
    assert.equal(read.transport, { dtlsState: 'connected', srtpCipher: 'SRTP_AEAD_AES_256_GCM', tlsVersion: 'FEFC', dtlsCipher: 'TLS_AES_128_GCM_SHA256', remoteFingerprint: 'sha-256 2C:38:63:48' });
    assert.equal(read.path, { localType: 'relay', remoteType: 'host', remotePort: 50123, relayed: true, availableOutgoingBitrate: 6_004_000, roundTripTime: 0.002 });
    // A browser that keeps a candidate's port back: null, which a session made without the relay reads as the worst.
    const portless = stats.map((stat) => (stat.id === 'R' ? { ...stat, port: undefined } : stat));
    assert.equal(readingOf({ forEach: (visit) => portless.forEach(visit) }).path.remotePort, null);
    assert.equal([read.video.codec, read.video.framesEncoded, read.video.totalPacketSendDelay, read.video.encoder, read.audio.packetsSent, read.fractionLost, read.microphoneSeconds], ['video/H264', 1424, null, null, 2699, 0.01, 54.2]);
    assert.equal([handshakeName('FEFC'), handshakeName('FEFD'), handshakeName(null)], ['DTLS 1.3', 'DTLS 1.2', 'DTLS']);
    // A browser that names no selected pair: the nominated one that succeeded.
    const without = stats.map((stat) => (stat.id === 'T' ? { ...stat, selectedCandidatePairId: undefined } : stat));
    assert.equal(readingOf({ forEach: (visit) => without.forEach(visit) }).path.relayed, true);
    assert.equal(readingOf({ forEach: () => {} }), { transport: null, path: null, video: null, audio: null, fractionLost: null, microphoneSeconds: null });
});

suite('the sessions');

test('put VP8 first once H.264 has encoded nothing with a picture to send', () => {
    const clock = new FakeClock();
    const sent = [];
    const broadcaster = new CameraBroadcaster({
        tracks: () => ({ video: null, audio: null, shortSide: 720 }), iceServers: async () => [], send: (viewer, session, payload) => sent.push({ viewer, session, payload }),
        rtc: /** @type {any} */ ({}), clock: { ...clock, at: () => clock.now() / 1000 },
    });
    const track = { muted: false, readyState: 'live' };
    const session = (codec, framesEncoded, since) => ({
        session: 's1', viewer: 'v1', isWatching: true, wantsVideo: true, playingSince: since, last: { reading: { video: { codec, framesEncoded } } },
        takeRelayedSeconds: () => 0, close() {},
    });
    const at = clock.now() / 1000;
    // Encoding, or only just started, or not H.264: nothing changes.
    for (const peer of [session('video/H264', 30, at - 20), session('video/H264', 0, at - 3), session('video/VP8', 0, at - 20)]) {
        broadcaster.peers.set('s1', /** @type {any} */ (peer));
        broadcaster.noteEncoder(/** @type {any} */ (peer), /** @type {any} */ (track));
        assert.equal([broadcaster.preferVp8, broadcaster.peers.size], [false, 1]);
    }
    // No picture to send (the page is hidden): that's no fault of the encoder's.
    const idle = session('video/H264', 0, at - 20);
    broadcaster.peers.set('s1', /** @type {any} */ (idle));
    broadcaster.noteEncoder(/** @type {any} */ (idle), /** @type {any} */ ({ muted: true, readyState: 'live' }));
    assert.equal(broadcaster.preferVp8, false);
    // Eight seconds of H.264 with a picture and no frame: VP8 first from here on, and this session ends so its viewer asks again.
    broadcaster.noteEncoder(/** @type {any} */ (idle), /** @type {any} */ (track));
    assert.equal([broadcaster.preferVp8, broadcaster.peers.size], [true, 0]);
    assert.equal(sent, [{ viewer: 'v1', session: 's1', payload: { kind: 'bye' } }]);
});
