// The camera's socket and its sealed signalling, with a stand-in socket, a
// clock a test moves, and a stand-in for the sessions: what comes in is
// acted on only if it opens as what it claims to be and is fresh, and what
// goes out is sealed, signed and shaped as the Worker takes it.

import { Gone, SocketLink } from '../src/camera/link.js';
import { CameraSignals } from '../src/camera/signals.js';
import { fromB64url } from '../src/crypto/bytes.js';
import { KeySet, SealContext } from '../src/crypto/keys.js';
import { PEEK_FRAME_SIZE, unpackPeekFrame } from '../src/crypto/peek.js';
import { SeenCommands } from '../src/wire/command.js';
import { CLOSE, HEARTBEAT, readFrame } from '../src/wire/frames.js';
import { readSignal } from '../src/wire/signal.js';
import { cameraStatus, readStatus } from '../src/wire/status.js';
import { FakeClock, settle } from './lib/fakes.js';
import { assert, suite, test } from './lib/harness.js';

suite('the socket');

class FakeSocket {
    constructor() {
        this.sent = [];
        this.closed = false;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
    }

    send(data) {
        if (this.closed) throw new Error('closed');
        this.sent.push(data);
    }

    close() {
        this.closed = true;
    }

    /** The far end's doing. */
    open() {
        this.onopen?.();
    }

    hear(data) {
        this.onmessage?.({ data });
    }

    drop(code) {
        this.closed = true;
        this.onclose?.({ code });
    }
}

/** A link whose sockets a test opens, answers and drops by hand. */
function linked(how = {}) {
    const clock = new FakeClock();
    const sockets = [];
    const states = [];
    const texts = [];
    let failing = how.failing ?? null;
    const link = new SocketLink({
        clock,
        random: () => 0.5,
        open: async () => {
            if (failing) throw failing;
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
    });
    link.onState = (state) => states.push(state);
    link.onText = (text) => texts.push(text);
    return { clock, sockets, states, texts, link, fail: (error) => (failing = error) };
}

test('pings every fifteen seconds, and comes back when no answer comes', async () => {
    const c = linked();
    c.link.start();
    await settle();
    c.sockets[0].open();
    assert.equal([c.link.isOpen, c.link.opened, c.states], [true, 1, ['open']]);
    assert.ok(c.link.send('{"type":"status"}') && c.link.sendBinary(Uint8Array.of(5)));
    // Answered pings keep it up for as long as it likes.
    for (let i = 0; i < 4; i++) {
        await c.clock.advance(HEARTBEAT.everyMs);
        assert.equal(c.sockets[0].sent.filter((frame) => frame === 'ping').length, i + 1);
        c.sockets[0].hear('pong');
    }
    await c.clock.advance(HEARTBEAT.replyWithinMs);
    assert.equal(c.sockets.length, 1);
    assert.equal(c.texts, [], 'the heartbeat is nobody else’s business');
    c.sockets[0].hear('{"type":"signal"}');
    assert.equal(c.texts, ['{"type":"signal"}']);
    // A ping with no answer in ten seconds: the connection died without closing.
    await c.clock.advance(HEARTBEAT.everyMs - HEARTBEAT.replyWithinMs);
    await c.clock.advance(HEARTBEAT.replyWithinMs - 1);
    assert.equal(c.link.isOpen, true);
    await c.clock.advance(1);
    assert.equal([c.link.isOpen, c.states.at(-1), c.sockets[0].closed], [false, 'closed', true]);
    assert.equal(c.link.send('x'), false, 'nothing is sent into a socket that is gone');
    await c.clock.advance(1_000);
    assert.equal(c.sockets.length, 2, 'a second later it tries again');
    c.sockets[1].open();
    assert.equal([c.link.isOpen, c.link.opened], [true, 2]);
    c.link.stop();
    assert.equal(c.sockets[1].closed, true);
});

test('tries again 1, 2, 4 … 30 seconds apart, and stops when the camera is over', async () => {
    const c = linked();
    c.link.start();
    await settle();
    c.sockets[0].open();
    const waits = [];
    for (let i = 0; i < 7; i++) {
        const before = c.sockets.length;
        const from = c.clock.now();
        c.sockets.at(-1).drop(1006);
        while (c.sockets.length === before) await c.clock.advance(500);
        waits.push(Math.round((c.clock.now() - from) / 1000));
    }
    assert.equal(waits, [1, 2, 4, 8, 16, 30, 30]);
    // It opens: the next drop starts from a second again.
    c.sockets.at(-1).open();
    c.sockets.at(-1).drop(1006);
    const count = c.sockets.length;
    await c.clock.advance(1_000);
    assert.equal(c.sockets.length, count + 1);
    // The Worker closes with 4003: the device is out of the home. The camera is over, and nothing is tried again.
    c.sockets.at(-1).open();
    c.sockets.at(-1).drop(CLOSE.gone);
    await c.clock.advance(120_000);
    assert.equal([c.states.at(-1), c.sockets.length, c.link.isOpen], ['gone', count + 1, false]);
});

test('stands down when this camera opened a socket elsewhere, and when there is no camera to open one for', async () => {
    const c = linked();
    c.link.start();
    await settle();
    c.sockets[0].open();
    // 4001: another socket of this device replaced it (the page in a second tab). It doesn't fight.
    c.sockets[0].drop(CLOSE.replaced);
    await c.clock.advance(120_000);
    assert.equal([c.states.at(-1), c.sockets.length], ['replaced', 1]);
    // Opening can fail for a while (no network): tried again. Or for good: the camera has ended.
    const offline = linked({ failing: new Error('offline') });
    offline.link.start();
    await offline.clock.advance(3_500);
    assert.equal([offline.sockets.length, offline.states], [0, []]);
    offline.fail(new Gone());
    await offline.clock.advance(10_000);
    assert.equal(offline.states, ['gone']);
    await offline.clock.advance(120_000);
    assert.equal(offline.sockets.length, 0);
});

suite('the signalling');

const CAMERA = 'c0000000-0000-4000-8000-00000000000c';
const VIEWER = 'd0000000-0000-4000-8000-00000000000d';
const OTHER = 'e0000000-0000-4000-8000-00000000000e';
const SESSION = '5e550000-0000-4000-8000-000000000005';

/** A camera's signalling over a link a test holds both ends of, and a member holding the camera's secret. */
async function signalling() {
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const member = await KeySet.fromSecrets({ 3: Uint8Array.from(secret) });
    const keys = await KeySet.forCamera(secret, 3);
    let now = 1_767_225_600_000;
    const calls = [];
    const out = [];
    const link = { isOpen: true, opened: 1, onText: null, onState: null, send: (text) => out.push(text) > 0, sendBinary: (bytes) => out.push(bytes) > 0 };
    const peers = new Map();
    const broadcaster = {
        peers,
        watch: async (...args) => calls.push(['watch', ...args]),
        answer: async (...args) => calls.push(['answer', ...args]),
        candidate: async (...args) => calls.push(['candidate', ...args]),
        bye: (...args) => calls.push(['bye', ...args]),
        refuse: (...args) => calls.push(['refuse', ...args]),
        end: (...args) => calls.push(['end', ...args]),
        viewerLeft: (...args) => calls.push(['viewerLeft', ...args]),
    };
    const commands = [];
    const kept = [];
    /** What the Worker itself said of the plan: each `limits_changed`, and 'plan_required' for each signal it turned away. */
    const plan = [];
    const signals = new CameraSignals({
        keys, cameraId: CAMERA, link, broadcaster: /** @type {any} */ (broadcaster), now: () => now, seen: new SeenCommands(),
        onCommand: (from, command) => commands.push([from, command]), onSeen: (seen) => kept.push(seen),
        onLimits: (limits) => plan.push(limits), onPlanRequired: () => plan.push('plan_required'),
    });
    /** A signal from a device, sealed as a member seals one, as the Worker hands it on. */
    const signal = async (payload, how = {}) => {
        const from = how.from ?? VIEWER;
        const session = how.session ?? SESSION;
        const sealed = await (how.keys ?? member).sealMessage(payload, SealContext.signal(how.sealedFrom ?? from, how.sealedTo ?? CAMERA, how.sealedSession ?? session));
        link.onText(JSON.stringify({ type: 'signal', from, session, payload: sealed }));
        await signals.settled();
    };
    const command = async (inner, how = {}) => {
        const from = how.from ?? VIEWER;
        const sealed = await member.sealMessage(inner, SealContext.command(how.sealedFrom ?? from, how.sealedTo ?? CAMERA));
        link.onText(JSON.stringify({ type: 'command', from, command: sealed }));
        await signals.settled();
    };
    return { member, keys, calls, out, link, peers, broadcaster, signals, commands, kept, plan, signal, command, now: () => now, tick: (ms) => (now += ms) };
}

test('acts on a signal only when it opens as its own and is fresh', async () => {
    const c = await signalling();
    await c.signal({ kind: 'watch', audio: true, quality: 'tile', warm: true, sent_at: c.now() });
    assert.equal(c.calls, [['watch', VIEWER, SESSION, { audio: true, quality: 'tile', warm: true, relay: true }, null]]);
    c.calls.length = 0;
    // A viewer whose Relay switch is off says so, and that is all a page goes by: it has no switch of its own.
    await c.signal({ kind: 'watch', relay: false, viewer_name: 'Kitchen iPad', sent_at: c.now() });
    await c.signal({ kind: 'watch', relay: true, sent_at: c.now() });
    assert.equal(c.calls.map((call) => [call[3].relay, call[4]]), [[false, 'Kitchen iPad'], [true, null]]);
    c.calls.length = 0;
    // True or false: a watch that says it any other way isn't a watch.
    await c.signal({ kind: 'watch', relay: 'off', sent_at: c.now() });
    // None of these is acted on, and none is answered.
    await c.signal({ kind: 'watch', sent_at: c.now() - 120_000 });
    await c.signal({ kind: 'watch', sent_at: c.now() + 120_000 });
    await c.signal({ kind: 'watch' });
    await c.signal({ kind: 'watch', sent_at: c.now() }, { sealedFrom: OTHER });
    await c.signal({ kind: 'watch', sent_at: c.now() }, { sealedTo: OTHER });
    await c.signal({ kind: 'watch', sent_at: c.now() }, { sealedSession: 'another-session' });
    await c.signal({ kind: 'watch', sent_at: c.now() }, { keys: await KeySet.fromSecrets({ 3: globalThis.crypto.getRandomValues(new Uint8Array(32)) }) });
    await c.signal({ sdp: 'v=0', sent_at: c.now() });
    await c.signal({ kind: 'wave', sent_at: c.now() });
    for (const junk of ['pong', '{', JSON.stringify({ type: 'signal', from: VIEWER, session: SESSION, payload: { kind: 'watch' } }), JSON.stringify({ type: 'keys_changed', epoch: 4 }), JSON.stringify({ type: 'wave' })]) c.link.onText(junk);
    await c.signals.settled();
    assert.equal([c.calls, c.out], [[], []]);
});

test('takes an answer only with a signature that holds', async () => {
    const c = await signalling();
    const sdp = 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n';
    await c.signal({ kind: 'answer', sdp, sig: await c.member.sign(`${SESSION}|answer|${sdp}`), sent_at: c.now() });
    assert.equal(c.calls, [['answer', VIEWER, SESSION, sdp]]);
    c.calls.length = 0;
    // Signed as an offer, signed for another session, altered, or not signed: never applied.
    c.peers.set(SESSION, { viewer: VIEWER });
    for (const sig of [await c.member.sign(`${SESSION}|offer|${sdp}`), await c.member.sign(`other|answer|${sdp}`), await c.member.sign(`${SESSION}|answer|${sdp.replace('AB:CD', 'EF:01')}`), null, 'not base64url!']) {
        await c.signal({ kind: 'answer', sdp, ...(sig === null ? {} : { sig }), sent_at: c.now() });
    }
    assert.equal(c.calls, Array(5).fill(['refuse', SESSION]), 'the session ends, and its viewer is told why');
    c.calls.length = 0;
    // From a device that isn't the session's viewer, a bad answer ends nothing.
    await c.signal({ kind: 'answer', sdp, sig: 'AAAA', sent_at: c.now() }, { from: OTHER });
    assert.equal(c.calls, []);
    await c.signal({ kind: 'candidate', candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdp_mid: '0', sdp_m_line_index: 0, sent_at: c.now() });
    await c.signal({ kind: 'bye', sent_at: c.now() });
    assert.equal(c.calls, [['candidate', VIEWER, SESSION, { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 }], ['bye', VIEWER, SESSION]]);
});

test('carries a command out once, within two minutes, from whoever really sent it', async () => {
    const c = await signalling();
    const peek = { command: { name: 'peek', value: 1 }, sent_at: c.now(), id: '0c0c0c0c-0000-4000-8000-00000000c001' };
    await c.command(peek);
    assert.equal(c.commands, [[VIEWER, { name: 'peek', on: null, value: 1, text: null }]]);
    assert.equal(Object.keys(c.kept.at(-1)), [peek.id], 'what it carried out is kept, for after a reload');
    await c.command(peek);
    await c.command({ ...peek, id: 'another', sent_at: c.now() - 120_000 });
    await c.command({ ...peek, id: 'a third' }, { sealedFrom: OTHER });
    await c.command({ ...peek, id: 'a fourth' }, { sealedTo: OTHER });
    await c.command({ command: { name: 'peek' }, sent_at: c.now() });
    assert.equal(c.commands.length, 1, 'a replay, a stale one, one moved from another sender or camera, one with no id: nothing');
    c.tick(60_000);
    await c.command({ ...peek, id: 'a fifth', sent_at: c.now() });
    assert.equal(c.commands.length, 2);
});

test('drops the session of a viewer the Worker says is gone, and acts on no other frame', async () => {
    const c = await signalling();
    c.peers.set(SESSION, { viewer: VIEWER });
    // Its socket carries no presence, no events and nobody's row: sent one anyway, it does nothing.
    c.link.onText(JSON.stringify({ type: 'presence', devices: [{ id: CAMERA, role: 'camera', online: true, status: null }] }));
    c.link.onText(JSON.stringify({ type: 'device_updated', device: { id: OTHER } }));
    c.link.onText(JSON.stringify({ type: 'temporary_camera_ended', device_id: CAMERA }));
    c.link.onText('not a frame at all');
    await c.signals.settled();
    assert.equal(c.calls, []);
    c.link.onText(JSON.stringify({ type: 'error', code: 'peer_offline', to: VIEWER, session: SESSION }));
    c.link.onText(JSON.stringify({ type: 'error', code: 'peer_offline', to: OTHER, session: SESSION }));
    c.link.onText(JSON.stringify({ type: 'error', code: 'camera_limit', to: VIEWER, session: SESSION }));
    await c.signals.settled();
    assert.equal(c.calls, [['end', SESSION, null, false]], "only the Worker's word that this session's own viewer is gone");
    assert.equal(c.plan, []);
});

test("hears from the Worker what its home's plan allows, and that a signal was turned away for want of one", async () => {
    const c = await signalling();
    // As it happens: the plan ran out, and later it's back with its caps.
    c.link.onText(JSON.stringify({ type: 'limits_changed', limits: null }));
    c.link.onText(JSON.stringify({ type: 'limits_changed', limits: { live_height: 1080, relay_height: 720 } }));
    // Caps that aren't two heights aren't a frame: nothing is made of them.
    for (const limits of [{ live_height: '720', relay_height: 720 }, { live_height: 720 }, { live_height: 0, relay_height: 720 }, 720, 'none']) c.link.onText(JSON.stringify({ type: 'limits_changed', limits }));
    await c.signals.settled();
    assert.equal(c.plan, [null, { liveHeight: 1080, relayHeight: 720 }]);
    assert.equal(c.calls, [], 'a plan that runs out ends nothing');
    c.plan.length = 0;

    // A signal of its own that came back: a session still being set up can't be, and goes without a word, since the word would come back the same way.
    c.peers.set(SESSION, { viewer: VIEWER, hasConnected: false });
    c.link.onText(JSON.stringify({ type: 'error', code: 'plan_required', to: VIEWER, session: SESSION }));
    await c.signals.settled();
    assert.equal([c.plan, c.calls], [['plan_required'], [['end', SESSION, null, false]]]);
    // A call already connected isn't the Worker's to end, nor the page's for the plan: it runs on.
    c.calls.length = 0;
    c.peers.set(SESSION, { viewer: VIEWER, hasConnected: true });
    c.link.onText(JSON.stringify({ type: 'error', code: 'plan_required', to: VIEWER, session: SESSION }));
    c.link.onText(JSON.stringify({ type: 'error', code: 'plan_required', to: OTHER, session: null }));
    await c.signals.settled();
    assert.equal([c.plan.length, c.calls], [3, []]);
});

test('seals and signs what goes out, for the one it goes to', async () => {
    const c = await signalling();
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
    await c.signals.send(VIEWER, SESSION, { kind: 'offer', sdp });
    const frame = JSON.parse(c.out[0]);
    assert.equal(Object.keys(frame), ['type', 'to', 'session', 'payload'], 'the three things the Worker passes on');
    assert.equal([frame.type, frame.to, frame.session], ['signal', VIEWER, SESSION]);
    // As the Worker hands it to the viewer, it reads as a frame an app takes.
    assert.ok(readFrame(JSON.stringify({ type: 'signal', from: CAMERA, session: frame.session, payload: frame.payload })) !== null);
    const opened = readSignal(await c.member.openMessage(frame.payload, SealContext.signal(CAMERA, VIEWER, SESSION), { fresh: true }));
    assert.equal([opened.kind, opened.sdp, opened.sentAt, opened.relay], ['offer', sdp, c.now(), null], 'with the relay it says nothing of it');
    assert.ok(await c.member.verify(`${SESSION}|offer|${sdp}`, opened.sig), "signed with the camera's signal key");
    // Made without the relay it says so, as false and never as true, after its signature, which is the same: `relay` is outside what it covers.
    const before = c.out.length;
    await c.signals.send(VIEWER, SESSION, { kind: 'offer', sdp, relay: false });
    await c.signals.send(VIEWER, SESSION, { kind: 'offer', sdp, relay: true });
    const [without, withIt] = await Promise.all(c.out.slice(before).map((text) => c.member.openMessage(JSON.parse(text).payload, SealContext.signal(CAMERA, VIEWER, SESSION), { fresh: true })));
    assert.equal(Object.keys(without), ['kind', 'sdp', 'sig', 'relay', 'sent_at']);
    assert.equal([without.relay, without.sig], [false, opened.sig]);
    assert.equal(Object.keys(withIt), ['kind', 'sdp', 'sig', 'sent_at']);
    c.out.length = before;
    // It opens for nobody else, and as nothing else.
    await assert.throws(() => c.member.openMessage(frame.payload, SealContext.signal(CAMERA, OTHER, SESSION), { fresh: true }));
    await assert.throws(() => c.member.openMessage(frame.payload, SealContext.status(CAMERA), { fresh: true }));
    await c.signals.send(VIEWER, SESSION, { kind: 'bye', reason: 'camera_stopped' });
    const bye = readSignal(await c.member.openMessage(JSON.parse(c.out[1]).payload, SealContext.signal(CAMERA, VIEWER, SESSION), { fresh: true }));
    assert.equal([bye.kind, bye.reason, bye.sig], ['bye', 'camera_stopped', null]);

    await c.signals.sendStatus(cameraStatus({ viewers: 1, noVideo: null, cameraPosition: 'back', battery: null, charging: null, appVersion: 'web (1)', endsAt: c.now() + 86_400_000 }));
    const status = JSON.parse(c.out[2]);
    assert.equal(Object.keys(status), ['type', 'status']);
    const said = await c.member.openMessage(status.status, SealContext.status(CAMERA), { fresh: true });
    assert.equal([said.viewers, said.ends_at, said.sent_at, readStatus(said) !== null], [1, c.now() + 86_400_000, c.now(), true]);

    // A still: sealed media, one size whatever the picture, its time inside.
    const jpeg = Uint8Array.of(0xff, 0xd8, 1, 2, 3, 0xff, 0xd9);
    assert.equal(await c.signals.sendStill(jpeg, c.now() - 40), true);
    const still = c.out[3];
    assert.equal([still[0], still.length], [0x05, 5 + 12 + PEEK_FRAME_SIZE + 16]);
    const frameInside = unpackPeekFrame(await c.member.openMedia(still, SealContext.peek(CAMERA), { fresh: true }));
    assert.equal([frameInside.capturedAtMs, frameInside.jpeg], [c.now() - 40, jpeg]);
    await assert.throws(() => c.member.openMedia(still, SealContext.peek(OTHER), { fresh: true }), "it opens only as this camera's");
    assert.equal(fromB64url(frame.payload.sealed)[0], 0x04);
});
