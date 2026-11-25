// Capture and staying awake (docs/WEB-CAMERA.md § 4), run against stand-ins
// for the browser's devices, its page and its clock. No camera or
// microphone is opened by any of it.

import { GRACE_MS, Keeper, RESTART_AT_MOST_EVERY_MS, STALL_MS } from '../src/capture/keeper.js';
import { ownMicrophone, plainName, whoseMicrophone } from '../src/capture/microphone.js';
import { CAPTURE, DeviceSource } from '../src/capture/source.js';
import { deviceKind } from '../src/device.js';
import { AIRPODS, AN_ANDROID_PHONE, A_MAC, FakeClock, FakeDoc, FakeMediaDevices, FakeMonitor, FakeWakeLock, settle } from './lib/fakes.js';
import { assert, suite, test } from './lib/harness.js';

suite('the device');

test('is called what the page can tell it is', () => {
    const agents = {
        iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        android_phone: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
        android_tablet: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
        mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15',
        windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0',
        chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
        computer: 'Mozilla/5.0 (X11; Linux x86_64; rv:160.0) Gecko/20100101 Firefox/160.0',
    };
    const names = { iphone: 'iPhone', android_phone: 'Android phone', android_tablet: 'Android tablet', mac: 'Mac', windows: 'Windows PC', chromebook: 'Chromebook', computer: 'Computer' };
    for (const [kind, userAgent] of Object.entries(agents)) assert.equal([deviceKind({ userAgent, maxTouchPoints: 0 }).kind, deviceKind({ userAgent }).name], [kind, names[kind]]);
    // An iPad says it's a Mac; a Mac has no touch screen.
    assert.equal(deviceKind({ userAgent: agents.mac, maxTouchPoints: 5 }).kind, 'ipad');
    assert.equal(deviceKind({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }).name, 'iPad');
    assert.equal([deviceKind({ userAgent: agents.android_phone }).noun, deviceKind({ userAgent: agents.android_tablet }).noun, deviceKind({ userAgent: agents.windows }).noun], ['phone', 'tablet', 'computer']);
    assert.equal([deviceKind({ userAgent: agents.mac }).this, deviceKind({ userAgent: agents.android_phone }).this, deviceKind({ userAgent: agents.windows }).this], ['this Mac', 'this phone', 'this PC']);
    // Only an iPhone or an iPad is told the app is the better camera to keep (decision 8).
    assert.equal(Object.keys(agents).filter((kind) => deviceKind({ userAgent: agents[kind] }).runsTheApp), ['iphone']);
});

suite('which microphone');

test("tells the device's own from one that's worn or carried, and admits what it can't tell", () => {
    const cases = [
        ['MacBook Pro Microphone', 'mac', 'own'],
        ['Default - MacBook Pro Microphone (Built-in)', 'mac', 'own'],
        ['MacBook Air Microphone', 'mac', 'own'],
        ['iMac Microphone', 'mac', 'own'],
        ['Studio Display Microphone', 'mac', 'own'],
        ['AirPods', 'mac', 'other'],
        ['Maya’s AirPods Pro', 'mac', 'other'],
        ['Maya’s iPhone Microphone', 'mac', 'other'],
        ['Beats Studio Buds', 'mac', 'other'],
        ['USB Audio Device', 'mac', 'unknown'],
        ['iPhone Microphone', 'iphone', 'own'],
        ['iPad Microphone', 'ipad', 'own'],
        ['AirPods', 'iphone', 'other'],
        ['Speakerphone', 'android_phone', 'own'],
        ['Bluetooth headset', 'android_phone', 'other'],
        ['Wired headset', 'android_phone', 'other'],
        ['Headset earpiece', 'android_phone', 'other'],
        ['Microphone Array (Realtek(R) Audio)', 'windows', 'own'],
        ['Headset Microphone (Jabra Evolve 65)', 'windows', 'other'],
        ['Microphone (HD Pro Webcam C920)', 'windows', 'unknown'],
        ['Internal Mic', 'chromebook', 'own'],
        ['', 'mac', 'unknown'],
    ];
    for (const [label, kind, whose] of cases) assert.equal(whoseMicrophone(label, kind), whose, `${label} on ${kind}`);
    assert.equal(plainName('Default - MacBook Pro Microphone (Built-in)'), 'MacBook Pro Microphone');
    assert.equal(plainName('FaceTime HD Camera (05ac:8514)'), 'FaceTime HD Camera');
    assert.equal(plainName('AirPods'), 'AirPods');
    // The system's "Default" is whatever it's using just now, so it's never the answer.
    assert.equal(ownMicrophone(AN_ANDROID_PHONE, 'android_phone'), { kind: 'audioinput', deviceId: 'mic-speaker', label: 'Speakerphone' });
    assert.equal(ownMicrophone([{ kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' }, AIRPODS], 'mac'), null);
    assert.equal(ownMicrophone([AIRPODS], 'mac'), null);
});

suite('the source');

test('asks for 720p at 30 and the camera that faces the room', async () => {
    const devices = new FakeMediaDevices(AN_ANDROID_PHONE);
    const source = new DeviceSource(devices, 'android_phone');
    await source.start();
    const first = devices.asked[0];
    assert.equal(first.video, { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: { ideal: 'environment' } });
    assert.equal(first.audio, { echoCancellation: true, noiseSuppression: false, autoGainControl: false });
    assert.equal(CAPTURE, { width: 1280, height: 720, frameRate: 30 });
    const using = source.using();
    assert.equal(using.camera, { name: 'camera2 0, facing back', deviceId: 'cam-back', position: 'back', width: 1280, height: 720, frameRate: 30 });
    // Chrome handed it "Default"; the phone's own is there by name, so that's asked for.
    assert.equal(using.microphone, { name: 'Speakerphone', deviceId: 'mic-speaker', whose: 'own' });
    assert.equal(devices.asked[1], { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'mic-speaker' } } });
    assert.equal(using.cameras.map((c) => c.deviceId), ['cam-front', 'cam-back']);
    source.stop();
    assert.equal(devices.open.length, 0, 'nothing is left open');
});

test("takes the device's own microphone when the system hands over a headset", async () => {
    // As on 2026-11-19: Safari on a Mac gave a page that only asked its owner's AirPods.
    const devices = new FakeMediaDevices([...A_MAC, AIRPODS], { defaultMicrophone: 'mic-airpods' });
    const source = new DeviceSource(devices, 'mac');
    const told = [];
    source.listen((what) => told.push(what));
    await source.start();
    assert.equal(source.using().microphone, { name: 'MacBook Pro Microphone', deviceId: 'mic-mac', whose: 'own' });
    assert.equal(source.using().camera.position, 'external');
    assert.equal(devices.open.map((t) => t.label).sort(), ['MacBook Pro Camera', 'MacBook Pro Microphone'], 'the headset was let go of');
    assert.ok(told.includes('tracks') && told.includes('using'));
    assert.equal(source.using().hasOwnMicrophone, true);
    source.stop();
});

test("says so when it can't tell which is the device's own", async () => {
    const devices = new FakeMediaDevices([A_MAC[0], AIRPODS, { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB Audio Device' }], { defaultMicrophone: 'mic-airpods' });
    const source = new DeviceSource(devices, 'mac');
    await source.start();
    // Nothing it can call the Mac's own: it keeps what it was given, and the name it reads off the track says what that is.
    assert.equal(source.using().microphone, { name: 'AirPods', deviceId: 'mic-airpods', whose: 'other' });
    assert.equal(source.using().hasOwnMicrophone, false);
    assert.equal(await source.useOwnMicrophone(), false);
    source.stop();
});

test('notices a headset connecting, and one going away', async () => {
    const devices = new FakeMediaDevices(A_MAC);
    const source = new DeviceSource(devices, 'mac');
    await source.start();
    let changes = 0;
    source.listen((what) => {
        if (what === 'using') changes += 1;
    });
    // A headset connects mid-evening and the system makes it the default: the camera stays on its own.
    devices.connect(AIRPODS, { becomesDefault: true });
    await settle();
    assert.equal(source.using().microphone.name, 'MacBook Pro Microphone');
    assert.equal(source.using().microphones.map((m) => m.name), ['MacBook Pro Microphone', 'AirPods']);
    assert.ok(changes >= 1, 'its screen hears of the change');
    // A person picks the headset on the camera's screen: that stands, and its screen says so.
    await source.useMicrophone('mic-airpods');
    assert.equal(source.using().microphone, { name: 'AirPods', deviceId: 'mic-airpods', whose: 'other' });
    devices.connect({ kind: 'audioinput', deviceId: 'mic-usb', label: 'USB Audio Device' });
    await settle();
    assert.equal(source.using().microphone.name, 'AirPods', 'a pick is left alone');
    // The headset goes away: the Mac's own is taken, not silence.
    devices.disconnect('mic-airpods');
    await settle();
    assert.equal(source.using().microphone, { name: 'MacBook Pro Microphone', deviceId: 'mic-mac', whose: 'own' });
    assert.equal(devices.open.map((t) => t.kind).sort(), ['audio', 'video']);
    // And "Use this Mac's microphone" goes back from a pick.
    devices.connect(AIRPODS);
    await source.useMicrophone('mic-airpods');
    assert.equal(await source.useOwnMicrophone(), true);
    assert.equal(source.using().microphone.whose, 'own');
    source.stop();
    devices.connect({ kind: 'audioinput', deviceId: 'mic-late', label: 'Late' });
    await settle();
    assert.equal(devices.open.length, 0, 'stopped, it asks for nothing more');
});

test('changes camera when a person picks another, and passes on a refusal', async () => {
    const devices = new FakeMediaDevices(AN_ANDROID_PHONE);
    const source = new DeviceSource(devices, 'android_phone');
    await source.start();
    const before = source.video;
    await source.useCamera('cam-front');
    assert.equal(source.using().camera.position, 'front');
    assert.ok(before.stopped, 'the camera it had is let go of');
    devices.refuse = 'NotAllowedError';
    const error = await assert.throws(() => source.restart('video'));
    assert.equal(error.name, 'NotAllowedError');
    assert.equal(source.using().camera.position, 'front', 'what it had stays until something better comes');
    source.stop();
    const never = new DeviceSource(new FakeMediaDevices([]), 'mac');
    assert.equal((await assert.throws(() => never.start())).name, 'NotFoundError');
});

suite('the keeper');

/** A camera running on stand-ins, with frames arriving until a test stops them. */
async function running(list = A_MAC, kind = 'mac') {
    const clock = new FakeClock();
    const doc = new FakeDoc();
    const wakeLock = new FakeWakeLock(doc);
    const devices = new FakeMediaDevices(list);
    const source = new DeviceSource(devices, kind);
    await source.start();
    const monitor = new FakeMonitor();
    const seen = [];
    const keeper = new Keeper(source, monitor, { doc, wakeLock, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval }, (kept) => seen.push({ ...kept }));
    let frames = true;
    clock.setInterval(() => {
        if (frames && doc.visibilityState === 'visible' && source.video && !source.video.muted && source.video.readyState === 'live') monitor.count += 3;
    }, 100);
    keeper.start();
    await settle();
    return { clock, doc, wakeLock, devices, source, monitor, keeper, seen, stopFrames: () => (frames = false), startFrames: () => (frames = true) };
}

test('holds the screen awake, and takes the hold again when the page comes back', async () => {
    const c = await running();
    await c.clock.advance(10_000);
    assert.equal(c.keeper.kept, { visible: true, noVideo: null, blocked: null, awake: 'held', silent: false });
    assert.equal(c.wakeLock.held.length, 1);
    assert.equal(c.monitor.showing, c.source.video);
    // The page is hidden for a moment on a computer: the browser drops the hold, the camera carries on.
    c.doc.hide();
    await settle();
    assert.equal([c.keeper.kept.visible, c.keeper.kept.awake, c.keeper.kept.noVideo], [false, 'released', null]);
    await c.clock.advance(30_000);
    assert.equal(c.devices.asked.length, 1, 'hidden, it asks for nothing');
    c.doc.show();
    await settle();
    assert.equal([c.keeper.kept.visible, c.keeper.kept.awake, c.wakeLock.held.length], [true, 'held', 1]);
    assert.ok(c.monitor.plays >= 1);
    c.keeper.stop();
    assert.equal(c.wakeLock.held.length, 0, 'stopped, the screen may sleep');
});

test('says the page is hidden when the browser takes the camera, and sees again on return', async () => {
    const c = await running(AN_ANDROID_PHONE, 'android_phone');
    await c.clock.advance(3_000);
    // A phone's browser takes the camera once the page is hidden.
    c.doc.hide();
    c.source.video.mute();
    await settle();
    assert.equal(c.keeper.kept.noVideo, 'background');
    await c.clock.advance(120_000);
    assert.equal(c.keeper.kept.noVideo, 'background');
    assert.equal(c.devices.asked.length, 2, 'hidden, it never asks for the camera again');
    c.doc.show();
    c.source.video.unmute();
    await c.clock.advance(2_000);
    assert.equal([c.keeper.kept.noVideo, c.keeper.kept.awake], [null, 'held']);
    assert.equal(c.devices.asked.length, 2, 'the browser gave it back, so nothing was asked');
    c.keeper.stop();
});

test('asks for the camera again when the picture stops for no reason, and less and less often', async () => {
    const c = await running();
    await c.clock.advance(4_000);
    c.stopFrames();
    await c.clock.advance(STALL_MS);
    assert.equal(c.keeper.kept.noVideo, null, 'five seconds without a frame is still a pause');
    await c.clock.advance(1_500);
    assert.equal(c.keeper.kept.noVideo, 'stalled');
    assert.equal(c.devices.asked.length, 1);
    await c.clock.advance(GRACE_MS);
    assert.equal(c.devices.asked.length, 2, 'asked for again once it had its moment');
    assert.equal(c.devices.asked[1], { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, deviceId: { exact: 'cam-mac' } } }, 'the same camera');
    // It didn't help. The tries after that come further and further apart, a minute at most.
    const before = c.devices.asked.length;
    await c.clock.advance(10 * 60_000);
    const tries = c.devices.asked.length - before;
    assert.ok(tries >= 9 && tries <= 14, `${tries} more tries in ten minutes`);
    assert.equal(RESTART_AT_MOST_EVERY_MS, 60_000);
    // Frames come back: it sees again.
    c.startFrames();
    await c.clock.advance(2_000);
    assert.equal(c.keeper.kept.noVideo, null);
    c.keeper.stop();
});

test('comes back from a track that ended, and waits for a tap when a person said no', async () => {
    const c = await running();
    await c.clock.advance(2_000);
    c.source.video.end();
    await settle();
    assert.equal(c.keeper.kept.noVideo, 'stalled');
    await c.clock.advance(GRACE_MS + 1_000);
    assert.equal([c.source.video.readyState, c.keeper.kept.noVideo], ['live', null], 'a new track, and it sees');
    // The permission is taken back: the track ends, and asking again is refused.
    c.devices.refuse = 'NotAllowedError';
    c.source.video.end();
    await c.clock.advance(GRACE_MS + 1_000);
    assert.equal([c.keeper.kept.noVideo, c.keeper.kept.blocked], ['stalled', 'denied']);
    const asked = c.devices.asked.length;
    await c.clock.advance(5 * 60_000);
    assert.equal(c.devices.asked.length, asked, 'it never nags: a no is a no until someone taps');
    c.devices.refuse = null;
    await c.keeper.tryAgain();
    await c.clock.advance(2_000);
    assert.equal([c.keeper.kept.noVideo, c.keeper.kept.blocked], [null, null]);
    c.keeper.stop();
});

test('asks for the microphone again when its track ends', async () => {
    const c = await running([...A_MAC, AIRPODS]);
    await c.source.useMicrophone('mic-airpods');
    await c.clock.advance(1_000);
    // The headset's battery dies with no word from the system but the track ending.
    c.source.audio.end();
    await settle();
    assert.equal(c.keeper.kept.silent, true);
    await c.clock.advance(GRACE_MS + 1_000);
    assert.equal(c.keeper.kept.silent, false);
    assert.equal(c.source.using().microphone.name, 'AirPods', 'it was the picked one, and it is still listed');
    c.devices.disconnect('mic-airpods');
    await c.clock.advance(GRACE_MS + 1_000);
    assert.equal(c.source.using().microphone.whose, 'own');
    c.keeper.stop();
});

test('is a camera without sound where there is no microphone, and takes one that turns up', async () => {
    const clock = new FakeClock();
    const doc = new FakeDoc();
    const devices = new FakeMediaDevices([A_MAC[0]]);
    const source = new DeviceSource(devices, 'mac');
    await source.start();
    assert.equal([source.video?.label, source.audio, source.using().microphone], ['MacBook Pro Camera', null, null]);
    const monitor = new FakeMonitor();
    const keeper = new Keeper(source, monitor, { doc, wakeLock: new FakeWakeLock(doc), now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval }, () => {});
    clock.setInterval(() => (monitor.count += 3), 100);
    keeper.start();
    await clock.advance(10 * 60_000);
    // It sees, it says it has no sound, and it doesn't keep asking for what isn't there.
    assert.equal([keeper.kept.noVideo, keeper.kept.blocked, keeper.kept.silent], [null, null, true]);
    assert.equal(devices.asked.filter((asked) => asked.audio && !asked.video).length, 1, 'asked for a microphone once more, and then left it');
    // A microphone is plugged in: it's taken.
    devices.connect(A_MAC[1]);
    await clock.advance(2_000);
    assert.equal([source.using().microphone?.name, keeper.kept.silent], ['MacBook Pro Microphone', false]);
    keeper.stop();
    source.stop();
});

test('carries on without a screen hold where the browser has none', async () => {
    const clock = new FakeClock();
    const doc = new FakeDoc();
    const source = new DeviceSource(new FakeMediaDevices(A_MAC), 'mac');
    await source.start();
    const keeper = new Keeper(source, new FakeMonitor(), { doc, wakeLock: undefined, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval }, () => {});
    keeper.start();
    await clock.advance(1_000);
    assert.equal(keeper.kept.awake, 'unsupported');
    keeper.stop();
    source.stop();
});
