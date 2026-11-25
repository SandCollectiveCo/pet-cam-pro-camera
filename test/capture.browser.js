// The capture code on a browser's real pieces (media streams, a video
// element, the wake lock), fed a drawn picture and a made tone. It is the
// same DeviceSource a real camera would run, handed dev/drawn.js in place
// of the browser's own cameras and microphones.

import { A_DRAWN_MAC, A_DRAWN_PHONE, DrawnDevices } from '../dev/drawn.js';
import { Keeper } from '../src/capture/keeper.js';
import { VideoMonitor } from '../src/capture/monitor.js';
import { DeviceSource } from '../src/capture/source.js';
import { fitsPeekFrame } from '../src/crypto/peek.js';
import { refusalFacts } from '../dev/guard.js';
import { assert, note, sleep, suite, test, until } from './lib/harness.js';

suite('capture in this browser');

/** A page in the background isn't drawn: its frames can't be counted, and it's refused the screen hold. */
const shown = () => document.visibilityState === 'visible';

test('a test page can never open a real camera or microphone', async () => {
    // By looking, never by asking. On 2026-11-24 an earlier form of this test
    // asked, to see the refusal: Safari had dropped the refusal with the
    // object it was put on, ignores the server's Permissions-Policy, and
    // gave this address the computer's real camera and microphone for the
    // three seconds until the tab closed. Nothing here calls for a real
    // device again, even to prove it can't have one.
    const facts = refusalFacts();
    const states = {};
    for (const name of ['camera', 'microphone']) states[name] = await navigator.permissions?.query({ name }).then((status) => status.state, (error) => `no answer (${error.name})`);
    note(`the page's refusal is on the prototype: ${facts.onPrototype}; what the browser says of this page: camera ${states.camera}, microphone ${states.microphone}`);
    assert.equal(facts, { inPlace: true, onPrototype: true, whatAPageFinds: 'the refusal', canBePutBack: false });
});

test('runs a drawn camera through the source, the monitor and the keeper', async () => {
    const devices = new DrawnDevices(document, A_DRAWN_PHONE);
    const source = new DeviceSource(devices, 'android_phone');
    const video = document.createElement('video');
    video.className = 'monitor';
    document.body.append(video);
    const monitor = new VideoMonitor(video, document);
    const seen = [];
    const keeper = new Keeper(source, monitor, { doc: document, wakeLock: navigator.wakeLock, now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) }, (kept) => seen.push(kept));
    try {
        await source.start();
        const using = source.using();
        assert.equal([using.camera.name, using.camera.position, using.microphone.name, using.microphone.whose], ['Back Camera', 'back', 'Speakerphone', 'own']);
        assert.equal([source.video.kind, source.video.readyState, source.audio.kind, source.audio.readyState], ['video', 'live', 'audio', 'live']);
        assert.equal([using.camera.width, using.camera.height], [1280, 720]);
        keeper.start();
        if (shown()) {
            await until(() => monitor.count >= 20, 'twenty frames of the drawn picture', 8_000);
            const before = monitor.count;
            await sleep(1_000);
            const fps = monitor.count - before;
            assert.ok(fps >= 15 && fps <= 62, `${fps} frames in a second`);
            await until(() => keeper.kept.awake !== 'released', 'an answer about the screen hold', 3_000);
            assert.equal([keeper.kept.visible, keeper.kept.noVideo, keeper.kept.blocked], [true, null, null]);
            // A still for a grid tile: a JPEG, small enough for a peek frame.
            await until(() => video.videoWidth > 0, 'the picture to have a size', 3_000);
            const jpeg = await monitor.still();
            assert.ok(jpeg && fitsPeekFrame(jpeg), 'a still that fits');
            assert.equal([jpeg[0], jpeg[1], jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]], [0xff, 0xd8, 0xff, 0xd9], 'a JPEG from start to end');
            // The other camera, picked on the screen: a new track, and frames again.
            await source.useCamera('drawn-front');
            assert.equal(source.using().camera.position, 'front');
            const afterSwap = monitor.count;
            await until(() => monitor.count > afterSwap + 5, 'frames from the other camera', 5_000);
        } else {
            await sleep(500);
            assert.equal(keeper.kept.visible, false);
        }
    } finally {
        keeper.stop();
        source.stop();
        assert.equal(devices.open.length, 0, 'the camera and the microphone are let go of');
        devices.close();
        video.remove();
    }
});

test("takes the device's own microphone over a headset the system handed it", async () => {
    const devices = new DrawnDevices(document, A_DRAWN_MAC, { defaultMicrophone: 'drawn-airpods' });
    const source = new DeviceSource(devices, 'mac');
    try {
        await source.start();
        assert.equal(source.using().microphone, { name: 'MacBook Pro Microphone', deviceId: 'drawn-mac-mic', whose: 'own' });
        assert.equal(devices.open.map((track) => track.label).sort(), ['MacBook Pro Camera', 'MacBook Pro Microphone']);
        await source.useMicrophone('drawn-airpods');
        assert.equal(source.using().microphone.whose, 'other');
        assert.equal(await source.useOwnMicrophone(), true);
        assert.equal(source.using().microphone.name, 'MacBook Pro Microphone');
    } finally {
        source.stop();
        devices.close();
    }
});
