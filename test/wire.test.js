// What's inside the sealed messages, on the data channel and around them on
// the socket, against docs/vectors/ (wire-v1, realtime-v1, and sealed-v1's
// list of what isn't sealed): this page reads each as the apps read it, and
// sends nothing the apps or the Worker would refuse.

import { KeySet, SealContext } from '../src/crypto/keys.js';
import { COMMAND_WINDOW_MS, SEEN_KEPT_MS, SeenCommands, commandIsFresh, peekSeconds, readCommand } from '../src/wire/command.js';
import { HEARTBEAT, MAX_SEALED, STUN_ONLY, isDeviceId, isSealed, isSession, readFrame, readIceServers, readOwnRow, signalFrame, statusFrame } from '../src/wire/frames.js';
import { QUALITIES, cameraStats, readPeerMessage } from '../src/wire/peer.js';
import { Refused } from '../src/wire/read.js';
import { BYE, SIGNAL_WINDOW_MS, byeSignal, candidateSignal, offerSignal, readSignal, signalIsFresh, watchTerms } from '../src/wire/signal.js';
import { NO_VIDEO, STATUS_REFRESH_MS, cameraStatus, readStatus, shownStatus } from '../src/wire/status.js';
import { assert, suite, test, vectors } from './lib/harness.js';
import { holder, outcome } from './lib/keys.js';

/** @param {unknown} value */
const viaJson = (value) => JSON.parse(JSON.stringify(value));

suite('wire-v1');

test('read a signal as the apps do, and refuse what they refuse', async () => {
    const group = (await vectors('wire-v1')).sealed.signal;
    const byName = {};
    for (const c of group.cases) {
        const read = readSignal(c.json);
        assert.equal(read !== null, c.apple === 'takes', `${c.name}: ${c.why}`);
        byName[c.name] = read;
    }
    assert.equal(watchTerms(byName.watch), { audio: true, quality: 'auto', warm: false, relay: true });
    assert.equal(watchTerms(byName.watch_ready), { audio: false, quality: 'tile', warm: true, relay: true });
    assert.equal(watchTerms(byName.watch_with_a_cap_from_later), { audio: true, quality: 'auto', warm: false, relay: true }, "a cap it doesn't know is auto");
    assert.equal(watchTerms(byName.watch_with_the_least), { audio: true, quality: 'auto', warm: false, relay: true });
    // The Relay switch: `relay` is only ever said as false, missing and null read as true, and a word that's neither refuses the signal.
    let relays = 0;
    for (const c of group.cases) {
        if (c.reads?.relay === undefined) continue;
        assert.equal(byName[c.name].relay ?? true, c.reads.relay, `${c.name}: ${c.why}`);
        if (byName[c.name].kind === 'watch') assert.equal(watchTerms(byName[c.name]).relay, c.reads.relay, c.name);
        relays += 1;
    }
    assert.equal(relays, 4);
    assert.equal([byName.watch_without_the_relay.relay, byName.offer_without_the_relay.relay, byName.bye_relay_off.reason, byName.relay_as_a_word], [false, false, BYE.relayOff, null]);
    assert.equal(byName.candidate.sdpMLineIndex, 0);
    assert.equal(byName.bye_keys_changed.reason, 'keys_changed');
    assert.equal(byName.a_kind_from_later.kind, 'wave');
    // A signal is acted on only within two minutes of the receiver's clock, either way.
    const sentAt = byName.watch.sentAt;
    assert.ok(signalIsFresh(byName.watch, sentAt) && signalIsFresh(byName.watch, sentAt + SIGNAL_WINDOW_MS - 1) && signalIsFresh(byName.watch, sentAt - SIGNAL_WINDOW_MS + 1));
    assert.ok(!signalIsFresh(byName.watch, sentAt + SIGNAL_WINDOW_MS) && !signalIsFresh(byName.watch, sentAt - SIGNAL_WINDOW_MS));
    assert.equal(signalIsFresh(byName.no_time, sentAt), false, 'no time counts as stale');
    for (const not of [null, 'watch', 7, [], [{ kind: 'watch' }]]) assert.equal(readSignal(not), null);
});

test('send only signals the apps take', () => {
    const offer = readSignal(viaJson({ ...offerSignal('v=0\r\n', 'c2ln'), sent_at: 1 }));
    assert.equal([offer.kind, offer.sdp, offer.sig, offer.relay], ['offer', 'v=0\r\n', 'c2ln', null]);
    // An offer for a session made without the relay says so as false, after its signature; with it, nothing, and never true.
    assert.equal(JSON.stringify(offerSignal('v=0\r\n', 'c2ln', false)), '{"kind":"offer","sdp":"v=0\\r\\n","sig":"c2ln","relay":false}');
    assert.equal([Object.keys(offerSignal('v=0\r\n', 'c2ln', true)), Object.keys(offerSignal('v=0\r\n', 'c2ln'))], [['kind', 'sdp', 'sig'], ['kind', 'sdp', 'sig']]);
    assert.equal(readSignal(viaJson({ ...offerSignal('v=0\r\n', 'c2ln', false), sent_at: 1 })).relay, false);
    const candidate = readSignal(viaJson(candidateSignal({ candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 })));
    assert.equal([candidate.kind, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex], ['candidate', 'candidate:1 1 udp 1 192.0.2.1 9 typ host', '0', 0]);
    assert.equal(viaJson(candidateSignal({ candidate: 'candidate:1', sdpMid: null, sdpMLineIndex: null })), { kind: 'candidate', candidate: 'candidate:1', sdp_m_line_index: 0 });
    assert.equal(byeSignal(), { kind: 'bye' });
    assert.equal(byeSignal(BYE.cameraStopped), { kind: 'bye', reason: 'camera_stopped' });
    assert.equal(byeSignal(BYE.relayOff), { kind: 'bye', reason: 'relay_off' });
    assert.equal(Object.values(BYE).sort(), ['bad_signature', 'camera_stopped', 'offer_failed', 'relay_limit', 'relay_off', 'timeout']);
});

test('read a command as the apps do, and carry it out only fresh and once', async () => {
    const group = (await vectors('wire-v1')).sealed.command;
    let judged = 0;
    for (const c of group.cases) {
        const read = readCommand(c.json);
        assert.equal(read !== null, c.apple === 'takes', `${c.name}: ${c.why}`);
        if (c.reads?.fresh !== undefined) {
            assert.equal(commandIsFresh(read, c.now, new Set(c.seen)), c.reads.fresh, `${c.name}: ${c.why}`);
            const seen = new SeenCommands(Object.fromEntries(c.seen.map((id) => [id, c.now - 1])));
            assert.equal(seen.take(read, c.now), c.reads.fresh, c.name);
            // Carried out or not, the same one never passes a second time.
            assert.equal(seen.take(read, c.now), false, c.name);
            judged += 1;
        }
    }
    assert.equal(judged, 6);
    assert.equal(COMMAND_WINDOW_MS, 120_000);
    const peek = readCommand(group.cases.find((c) => c.name === 'peek').json);
    assert.equal([peek.command.name, peekSeconds(peek.command)], ['peek', 30]);
    assert.equal(peekSeconds({ name: 'peek', on: null, value: 900, text: null }), 35, 'at most 35 seconds');
    assert.equal(peekSeconds({ name: 'peek', on: null, value: null, text: null }), 30);
    assert.equal(peekSeconds({ name: 'peek', on: null, value: 0, text: null }), 1);
});

test('keep the ids it carried out for five minutes, across reloads', () => {
    const command = (id, sentAt) => ({ command: { name: 'peek', on: null, value: 1, text: null }, sentAt, id });
    const first = new SeenCommands();
    assert.ok(first.take(command('a', 1_000), 1_000));
    // What it keeps comes back after a reload, and still refuses the same id.
    const reloaded = new SeenCommands(viaJson(first.kept()));
    assert.equal(reloaded.take(command('a', 1_000), 60_000), false);
    assert.ok(reloaded.take(command('b', 60_000), 60_000));
    // Past five minutes an id is forgotten, by when its command's window has long closed.
    assert.ok(reloaded.take(command('c', 1_000 + SEEN_KEPT_MS), 1_000 + SEEN_KEPT_MS));
    assert.equal(Object.keys(reloaded.kept()).sort(), ['b', 'c']);
    assert.equal(reloaded.take(command('a', 1_000), 1_000 + SEEN_KEPT_MS), false, 'forgotten, and long stale');
});

test("read the data channel's messages as the apps do", async () => {
    const group = (await vectors('wire-v1')).data_channel;
    for (const c of group.cases) {
        const read = readPeerMessage(c.json);
        assert.equal(read !== null, c.apple === 'takes', `${c.name}: ${c.why}`);
        if (!c.reads) continue;
        assert.equal(read.type, c.reads.type, c.name);
        if ('quality' in c.reads) assert.equal(read.quality, c.reads.quality, c.name);
        if ('on' in c.reads) assert.equal(read.on, c.reads.on, c.name);
        if ('step' in c.reads) assert.equal(read.stats.step, c.reads.step, c.name);
    }
    assert.equal(QUALITIES, ['auto', 'high', 'medium', 'low', 'tile', 'tile_small']);
    for (const not of [null, 'play', 7, []]) assert.equal(readPeerMessage(not), null);
});

test('tell a viewer of its link only in words the apps take', () => {
    const least = cameraStats({ step: '360p15' });
    assert.equal(least, { type: 'camera_stats', stats: { step: '360p15' } });
    const full = cameraStats({ step: '720p30', width: 1280, height: 720, fps: 29.97, targetKbps: 2400.4, bandwidthKbps: 5000, encodeMs: 4.25, sendQueueMs: 1.5, limitation: 'none', encoder: 'ExternalEncoder', micPercent: 99.5 });
    assert.equal(full.stats, { step: '720p30', width: 1280, height: 720, fps: 29.97, target_kbps: 2400, bandwidth_kbps: 5000, encode_ms: 4.25, send_queue_ms: 1.5, limitation: 'none', encoder: 'ExternalEncoder', mic_percent: 99.5 });
    // What it doesn't know (a browser tells no heat) is left out, never guessed.
    assert.equal('thermal' in full.stats, false);
    assert.equal(cameraStats({ step: '540p30', width: null, fps: Number.NaN, targetKbps: undefined }).stats, { step: '540p30' });
    for (const message of [least, full]) assert.equal(readPeerMessage(viaJson(message)).stats.step, message.stats.step);
});

test('read a status as the apps do, and say only what they take', async () => {
    const group = (await vectors('wire-v1')).sealed.camera_status;
    for (const c of group.cases) {
        const read = readStatus(c.json);
        assert.equal(read !== null, c.apple === 'takes', `${c.name}: ${c.why}`);
        if (c.reads && 'no_video' in c.reads) assert.equal(read.noVideo, c.reads.no_video, c.name);
        if (c.reads && 'orientation' in c.reads) assert.equal(read.orientation, c.reads.orientation, c.name);
    }
    // What a temporary camera says, from the same facts as the contract's vectors (test/temporary-camera.test.js holds it to their text).
    const seeing = cameraStatus({ viewers: 1, noVideo: null, cameraPosition: 'back', battery: 0.6659, charging: true, appVersion: 'web (3)', endsAt: 1767312000000 });
    const hidden = cameraStatus({ viewers: 0, noVideo: NO_VIDEO.background, cameraPosition: 'front', battery: null, charging: null, appVersion: 'web (3)', endsAt: 1767312000000 });
    for (const status of [seeing, hidden]) {
        const read = readStatus(viaJson({ ...status, sent_at: 1767225600000 }));
        assert.equal(read, { noVideo: status.no_video ?? null, orientation: null });
    }
    // An end that isn't a whole number of milliseconds is one the apps would refuse the whole status for.
    assert.equal(readStatus({ ...seeing, ends_at: 1.5 }), null);
    // It has no detection, no zoom, no light and no Paused to offer, so it names none; a camera whose position the browser doesn't say names none either.
    for (const key of ['detection', 'zoom', 'zoom_range', 'light', 'orientation', 'thermal', 'armed', 'night_light', 'quality', 'no_video']) assert.equal(key in seeing, false, key);
    assert.equal('camera_position' in cameraStatus({ viewers: 0, noVideo: null, cameraPosition: null, battery: null, charging: null, appVersion: 'web (3)', endsAt: 1 }), false);
    // A status goes when what a viewer shows of it changes, not for its time alone.
    assert.equal(shownStatus({ ...seeing, sent_at: 1 }), shownStatus({ ...seeing, sent_at: 2 }));
    assert.notEqual(shownStatus(seeing), shownStatus(hidden));
    assert.equal(STATUS_REFRESH_MS, 300_000);
    // More time is something a viewer shows, so a new end sends a status at once.
    assert.notEqual(shownStatus(seeing), shownStatus({ ...seeing, ends_at: seeing.ends_at + 86_400_000 }));
});

test("read who's calling from a watch, held to the rule for names", () => {
    // A watch that names nobody, or says something that's no name, is still a watch; a name is held to the rule for names.
    for (const name of [undefined, null, 7, '', '   ', ['Kitchen iPad']]) assert.equal(readSignal({ kind: 'watch', viewer_name: name, sent_at: 1 }).viewerName, null);
    assert.equal(readSignal({ kind: 'watch', viewer_name: '  Kitchen \n iPad ', sent_at: 1 }).viewerName, 'Kitchen iPad');
    assert.equal(readSignal({ kind: 'watch', viewer_name: 'a'.repeat(500), sent_at: 1 }).viewerName.length, 60);
});

suite('sealed-v1');

test('know what is sealed from what is not, as the Worker does', async () => {
    const file = await vectors('sealed-v1');
    for (const [name, m] of Object.entries(file.messages)) assert.ok(isSealed({ sealed: m.sealed }), name);
    for (const c of file.opening.messages) if (c.sealed !== undefined) assert.equal(isSealed({ sealed: c.sealed }), c.worker_takes, `${c.name}: ${c.why}`);
    for (const plain of file.not_sealed.messages) assert.equal(isSealed({ sealed: plain.value }), false, plain.why);
    for (const plain of file.not_sealed.json) assert.equal(isSealed(plain.value), false, plain.why);
    for (const media of Object.values(file.media)) assert.equal(isSealed({ sealed: media.sealed }), false, 'media where a message belongs');
    // A command or a status is at most 4,096 characters; a signal, 65,536.
    assert.ok(isSealed({ sealed: file.messages.command.sealed }, MAX_SEALED.command));
    assert.equal(isSealed({ sealed: file.messages.status.sealed }, file.messages.status.sealed.length - 1), false);
});

suite('realtime-v1');

test("read the Worker's frames as the apps do, and open what's sealed inside", async () => {
    const file = await vectors('realtime-v1');
    const keys = await holder(file, file.signer);
    let opened = 0;
    for (const c of file.frames_from_server.cases) {
        const frame = readFrame(JSON.stringify(c.json));
        assert.equal(frame !== null, c.apps === 'takes', `${c.name}: ${c.why}`);
        if (frame === null) continue;
        assert.equal(frame.type, c.reads.type, c.name);
        if (frame.type === 'presence') {
            assert.equal(frame.devices.length, c.reads.devices.length, c.name);
            for (const [i, device] of frame.devices.entries()) {
                const expected = c.reads.devices[i];
                assert.equal([device.id, device.role, device.online], [expected.id, expected.role, expected.online], c.name);
                // A status opens only as its own camera's, under the current keys.
                const status = device.status === null ? { expect: 'none' } : await outcome(() => keys.openMessage(device.status, SealContext.status(device.id), { fresh: true }));
                assert.equal(status.value ?? null, expected.status, `${c.name}: ${device.id}`);
                if (status.expect === 'opens') {
                    assert.ok(readStatus(status.value) !== null);
                    opened += 1;
                }
            }
        } else if (frame.type === 'signal') {
            assert.equal([frame.from, frame.session], [c.reads.from, c.reads.session], c.name);
            const inside = await keys.openMessage(frame.payload, SealContext.signal(frame.from, file.as, frame.session), { fresh: true });
            assert.equal(inside, c.reads.payload, c.name);
            const signal = readSignal(inside);
            assert.equal(signal.kind, 'offer');
            assert.ok(await keys.verify(`${frame.session}|offer|${signal.sdp}`, signal.sig), 'the offer is signed');
            assert.ok(signalIsFresh(signal, file.now));
            // For another device, or another session, it doesn't open: the server can't re-aim one.
            assert.equal((await outcome(() => keys.openMessage(frame.payload, SealContext.signal(frame.from, file.ids.other_device, frame.session), { fresh: true }))).expect, 'refused');
            assert.equal((await outcome(() => keys.openMessage(frame.payload, SealContext.signal(frame.from, file.as, 'another-session'), { fresh: true }))).expect, 'refused');
            opened += 1;
        } else if (frame.type === 'error') {
            assert.equal([frame.code, frame.to, frame.session], [c.reads.code, c.reads.to, c.reads.session], c.name);
        } else if (frame.type === 'keys_changed') {
            assert.equal(frame.epoch, c.reads.epoch);
        }
    }
    // The camera's status where it's listed as its own, and its offer.
    assert.equal(opened, 2);
    for (const not of ['', 'pong', '{', 'null', '7']) assert.equal(readFrame(not), null);
});

test('send only frames the Worker takes', async () => {
    const file = await vectors('realtime-v1');
    const cases = file.frames_to_server.cases;
    assert.equal(cases.map((c) => c.worker).sort().filter((v, i, all) => all.indexOf(v) === i), ['drops', 'takes']);
    let refused = 0;
    for (const c of cases) {
        if (c.json.type !== 'signal') continue;
        const build = () => signalFrame(c.json.to, c.json.session, c.json.payload);
        if (c.worker === 'takes') {
            // What goes out is the three things the Worker passes on, and nothing beside them.
            assert.equal(JSON.parse(build()), { type: 'signal', to: c.json.to, session: c.json.session, payload: c.json.payload }, c.name);
            assert.equal(c.delivers.payload, c.json.payload, c.name);
        } else {
            const error = await assert.throws(build, `${c.name}: ${c.why}`);
            assert.ok(error instanceof Refused, c.name);
            refused += 1;
        }
    }
    assert.ok(refused >= 10, `refused ${refused} frames the Worker would drop without a word`);
    assert.ok(isDeviceId(file.ids.camera) && !isDeviceId(file.ids.camera.toUpperCase()) && !isDeviceId('role:camera'));
    assert.ok(isSession('a') && isSession('A-z_0'.repeat(12) + 'abcd') && !isSession('') && !isSession('one two') && !isSession('x'.repeat(65)));
    // A status is sealed or it doesn't go.
    const keys = await KeySet.forCamera(globalThis.crypto.getRandomValues(new Uint8Array(32)), 0);
    const status = await keys.sealMessage({ armed: true, sent_at: 1 }, SealContext.status(file.ids.camera));
    assert.equal(JSON.parse(statusFrame(status)), { type: 'status', status });
    for (const plain of [{ armed: true }, { sealed: 'eyJhcm1lZCI6dHJ1ZX0' }, { ...status, more: 1 }, status.sealed]) await assert.throws(() => statusFrame(plain), 'a status that is not sealed');
});

test("read what the Worker says of a temporary camera: its plan's caps as they change, and its own row with the Worker's clock", () => {
    // As docs/API.md writes them (Temporary cameras, What the Worker holds it to): no vector pins these, since no Worker sends them yet.
    assert.equal(readFrame('{ "type": "limits_changed", "limits": null }'), { type: 'limits_changed', limits: null });
    assert.equal(readFrame('{ "type": "limits_changed", "limits": { "live_height": 720, "relay_height": 720 } }'), { type: 'limits_changed', limits: { liveHeight: 720, relayHeight: 720 } });
    assert.equal(readFrame('{ "type": "limits_changed", "limits": { "live_height": 1080, "relay_height": 720, "later": true } }').limits, { liveHeight: 1080, relayHeight: 720 }, 'a field from later is passed over');
    for (const limits of ['720', 720, [], { live_height: 720 }, { live_height: '720', relay_height: 720 }, { live_height: 720.5, relay_height: 720 }, { live_height: 0, relay_height: 720 }, { live_height: 720, relay_height: -1 }]) {
        assert.equal(readFrame(JSON.stringify({ type: 'limits_changed', limits })), null, JSON.stringify(limits));
    }
    const device = { id: '2ca1a748-46c3-82c3-a872-c637b3a6697b', household_id: '11111111-2222-4333-8444-555555555555', role: 'camera', platform: 'web', model: 'Android phone', temporary: { ends_at: 1767312000000 } };
    assert.equal(readOwnRow({ device, limits: { live_height: 720, relay_height: 720 }, now: 1767225600000 }), { deviceId: device.id, householdId: device.household_id, endsAt: 1767312000000, limits: { liveHeight: 720, relayHeight: 720 }, now: 1767225600000 });
    // No plan that allows it: its row all the same, and nobody can watch.
    assert.equal(readOwnRow({ device, limits: null, now: 1767225600000 }).limits, null);
    // Before it's approved it has no home and no mark; a Worker that doesn't say its time is read without one.
    assert.equal(readOwnRow({ device: { id: device.id, household_id: null }, limits: null }), { deviceId: device.id, householdId: null, endsAt: null, limits: null, now: null });
    for (const not of [null, {}, { device: null, now: 1 }, { device: {}, now: 1 }, { device, limits: { live_height: 720 }, now: 1 }, { device, limits: null, now: '1767225600000' }, { device, limits: null, now: 1767225600000.5 }, { device: { ...device, temporary: 7 }, now: 1 }]) {
        assert.equal(readOwnRow(not), null, JSON.stringify(not));
    }
});

test('name the heartbeat the Worker answers, often enough', async () => {
    const beat = (await vectors('realtime-v1')).heartbeat;
    assert.equal([HEARTBEAT.ping, HEARTBEAT.pong], [beat.ping, beat.pong]);
    assert.ok(HEARTBEAT.everyMs <= beat.ping_at_least_every_ms);
    assert.ok(HEARTBEAT.everyMs + HEARTBEAT.replyWithinMs < beat.gone_after_ms / 2);
});

test('read the list of relay addresses as the apps do', async () => {
    const cases = (await vectors('realtime-v1')).ice_servers.cases;
    for (const c of cases) {
        const read = readIceServers(c.json);
        assert.equal(read !== null, c.apps === 'takes', `${c.name}: ${c.why}`);
        if (read) assert.equal({ ice_servers: read.iceServers, expires_at: read.expiresAt, relay: read.relay }, c.reads, c.name);
    }
    assert.equal(STUN_ONLY, cases.find((c) => c.name === 'stun_only').reads.ice_servers);
});
