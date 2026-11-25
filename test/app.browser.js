// The whole page, from opening to its end, on stand-ins: a door that hands
// over a made-up pass (dev/door.js), a drawn picture for its camera, and a
// stand-in viewer on the other side of a stand-in socket. What a person
// would see is read off the page itself.

import { ANY_SUITE_FOR_TESTS } from '../dev/any-suite.js';
import { standInDoor } from '../dev/door.js';
import { A_DRAWN_MAC, A_DRAWN_PHONE, DrawnDevices } from '../dev/drawn.js';
import { Relay } from '../dev/relay.js';
import { StandInViewer } from '../dev/viewer.js';
import { runApp } from '../src/app.js';
import { SealContext } from '../src/crypto/keys.js';
import { unpackPeekFrame } from '../src/crypto/peek.js';
import { randomId } from '../src/crypto/primitives.js';
import { readStatus } from '../src/wire/status.js';
import { assert, note, sleep, suite, test, until, vectors } from './lib/harness.js';

suite('the page');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15';

const clock = () => ({
    now: () => Date.now(),
    at: () => performance.now() / 1000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
});

/** The page, opened in a corner of this one, on stand-ins. */
async function opened(how = {}) {
    const relay = new Relay();
    const door = await standInDoor({ relay, ...how.door });
    const devices = new DrawnDevices(document, how.devices ?? A_DRAWN_PHONE, how.defaults);
    const root = document.createElement('main');
    root.className = 'page-under-test';
    document.body.append(root);
    const app = runApp({
        doc: document, root, door, mediaDevices: how.mediaDevices === null ? undefined : devices,
        rtc: { RTCPeerConnection, RTCRtpSender, MediaStream }, wakeLock: navigator.wakeLock, battery: how.battery,
        agent: { userAgent: how.agent ?? ANDROID, maxTouchPoints: how.agent === MAC ? 0 : 5 }, clock: clock(), appVersion: 'web (0)', secure: true, terms: ANY_SUITE_FOR_TESTS,
    });
    /** What the page says, as a person would read it: each piece of text, a space between. */
    const text = () => {
        const pieces = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim() !== '' && !node.parentElement.closest('noscript')) pieces.push(node.textContent.trim());
        return pieces.join(' ');
    };
    const tap = async (label) => {
        // A button by what it says; a row by the name it shows.
        const button = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.querySelector('.name')?.textContent === label || b.getAttribute('aria-label')?.includes(label));
        assert.ok(button, `a button that says "${label}" (the page says: ${text()})`);
        button.click();
        await sleep(30);
    };
    return {
        relay, door, devices, root, app, text, tap,
        /** A stand-in viewer holding this camera's keys, as a member will. */
        async viewer() {
            const id = randomId();
            return new StandInViewer({ id, cameraId: door.cameraId, keys: await door.memberKeys(), link: relay.join(id), doc: document });
        },
        close() {
            app.camera()?.end('here');
            devices.close();
            root.remove();
            document.body.classList.remove('lit');
            document.title = 'Pet Cam Pro camera page: tests';
        },
    };
}

test('goes from a code to a camera to its end, saying each thing in its place', async () => {
    const p = await opened({ door: { startedBy: 'Maya Lopez', approves: 'when told', lastsMs: 86_400_000 } });
    try {
        // ---- Asking, the same six digits, Approve on the viewer ----
        await until(() => p.text() === 'Asking the viewer…', 'the page to say it is asking', 2_000, 5);
        await until(() => p.text().startsWith('862 673'), 'the six digits');
        assert.equal(p.devices.asks, 0, 'no camera is asked for before someone is let in and taps Start');
        p.door.approve();
        // ---- Approved: whose camera this will be, until when, and Start ----
        await until(() => p.text().includes('is borrowing'), 'the approved page');
        assert.ok(/^Maya Lopez is borrowing this phone as a camera until tomorrow, \d{1,2}:\d{2}( [AP]M)?\. Start the camera$/.test(p.text()), p.text());
        assert.equal(p.devices.asks, 0);
        await p.tap('Start the camera');
        // ---- A camera ----
        await until(() => p.text().includes('Live'), 'the camera to be live', 10_000);
        const lit = p.text();
        for (const part of ['Live', 'Maya Lopez’s camera', 'until tomorrow', 'Camera Back Camera', 'Microphone Speakerphone', 'Stop']) assert.ok(lit.includes(part), `"${part}" on the camera's screen: ${lit}`);
        assert.ok(!lit.includes('watching'), 'nobody is watching yet');
        assert.ok(document.body.classList.contains('lit'));
        assert.equal(p.devices.open.map((track) => track.label).sort(), ['Back Camera', 'Speakerphone']);
        // It says how it is, sealed, and the home can open that.
        const member = await p.door.memberKeys();
        const status = await until(() => p.relay.statuses.get(p.door.cameraId), "the camera's status", 8_000);
        const said = await member.openMessage(status, SealContext.status(p.door.cameraId), { fresh: true });
        assert.equal([said.viewers, said.no_video ?? null, said.camera_position, said.app_version, said.ends_at], [0, null, 'back', 'web (0)', p.door.pass.endsAt]);
        assert.equal(Object.keys(said).sort(), ['app_version', 'camera_position', 'ends_at', 'sent_at', 'viewers'], 'what a page can tell, and nothing else (the drawn devices tell no battery)');
        assert.ok(readStatus(said) !== null && Math.abs(said.sent_at - Date.now()) < 10_000);

        // ---- Someone watches ----
        const viewer = await p.viewer();
        const forwarder = await (await fetch('/__forwarder', { method: 'POST' })).json();
        viewer.only = forwarder.second;
        // Its watch says what it's called, as an app's does to a temporary camera.
        await viewer.watch({ viewer_name: '  Maya’s\n iPhone ' });
        await until(() => viewer.offer, "the camera's offer");
        await viewer.signal({ kind: 'candidate', candidate: forwarder.first, sdp_mid: '0', sdp_m_line_index: 0 });
        await until(() => p.text().includes('Maya’s iPhone watching'), 'the camera to say who is watching', 20_000);
        await until(async () => ((await viewer.look()).video?.framesDecoded ?? 0) > 10, 'the drawn picture at the viewer', 15_000);
        await until(async () => (await member.openMessage(p.relay.statuses.get(p.door.cameraId), SealContext.status(p.door.cameraId), { fresh: true })).viewers === 1, 'its status to count the viewer', 8_000);

        // ---- A still for a grid tile ----
        assert.equal(p.relay.stills.get(p.door.cameraId), undefined, 'no still goes that nobody asked for');
        await viewer.command({ name: 'peek', value: 2 });
        const stills = await until(() => p.relay.stills.get(p.door.cameraId), 'a still', 8_000);
        assert.equal([stills[0][0], stills[0].length], [0x05, 5 + 12 + 32_768 + 16], 'sealed media, one size whatever the picture');
        // A member opens it as this camera's: the moment it was taken, and a JPEG.
        const still = unpackPeekFrame(await member.openMedia(stills[0], SealContext.peek(p.door.cameraId), { fresh: true }));
        assert.ok(Math.abs(still.capturedAtMs - Date.now()) < 8_000, 'taken just now');
        assert.equal([still.jpeg[0], still.jpeg[1], still.jpeg.at(-2), still.jpeg.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
        note(`a still of ${still.jpeg.length} bytes, padded and sealed to ${stills[0].length}`);

        // ---- More time, and never past what its pass allowed ----
        const before = p.app.camera().pass.endsAt;
        const saidEnd = async () => (await member.openMessage(p.relay.statuses.get(p.door.cameraId), SealContext.status(p.door.cameraId), { fresh: true })).ends_at;
        await viewer.command({ name: 'keep', value: before + 86_400_000 });
        await until(() => p.app.camera().pass.endsAt === before + 86_400_000, 'another day');
        await until(async () => (await saidEnd()) === before + 86_400_000, 'its status to name its new end', 8_000);
        // A sooner end, no end at all, or one that's no whole number: it keeps the end it has.
        for (const value of [before, undefined, before + 86_400_000 + 0.5]) await viewer.command({ name: 'keep', ...(value === undefined ? {} : { value }) });
        await viewer.command({ name: 'keep', value: before + 30 * 86_400_000 });
        await until(() => p.app.camera().pass.endsAt === p.door.pass.latestEndAt, 'no more than a week in all');
        await until(async () => (await saidEnd()) === p.door.pass.latestEndAt, 'its status to name the end it holds itself to', 8_000);
        assert.ok(p.door.kept.length >= 2, 'a later end is kept for after a reload');

        // ---- Stop asks first, then it's over ----
        await p.tap('Stop');
        assert.ok(p.text().includes('Stop the camera?'));
        await p.tap('Cancel');
        assert.ok(!p.text().includes('Stop the camera?') && p.text().includes('Live'));
        await p.tap('Stop');
        await p.tap('Stop Camera');
        await until(() => p.text().startsWith('That’s the camera done.'), 'the page at its end');
        assert.equal(p.text(), 'That’s the camera done. Close the page and it’s just a phone again. If you let this page use the camera every time, you can take that back in the browser’s settings for this site.');
        assert.equal(p.devices.open.length, 0, 'the camera and the microphone are let go of');
        assert.equal(p.door.left, true, 'its device and everything the browser kept are deleted');
        await until(() => viewer.heard.find((signal) => signal.kind === 'bye'), 'the viewer to be told');
        assert.equal(viewer.heard.find((signal) => signal.kind === 'bye').reason, 'camera_stopped');
        assert.ok(!document.body.classList.contains('lit'));
        assert.equal(document.title, 'Pet Cam Pro camera');
        viewer.close();
    } finally {
        p.close();
    }
});

test('goes black with a faint clock when left alone, and lights at a tap', async () => {
    const p = await opened({ door: { arrive: 'kept', startedBy: 'Maya Lopez' } });
    try {
        await until(() => p.text().includes('Live'), 'a camera opened again to carry on, with no tap', 10_000);
        assert.equal(p.devices.asks >= 1, true);
        // Left alone its controls go: here by saying so, in a real page after half a minute.
        const screen = p.app.screen;
        screen.lit = false;
        screen.draw();
        const dark = p.root.querySelector('button.dark');
        assert.ok(dark && !document.body.classList.contains('lit'));
        assert.ok(/^\d{1,2}:\d{2}Live · Maya Lopez’s camerauntil tomorrow, /.test(dark.textContent), dark.textContent);
        assert.ok(dark.getAttribute('aria-label').startsWith('Live. Maya Lopez’s camera, until tomorrow'));
        assert.equal(p.root.querySelectorAll('button').length, 1, 'nothing to tap by accident but the page itself');
        // The clock moves, so no part of a screen shows it for long.
        const place = () => [p.root.querySelector('.rest').style.left, p.root.querySelector('.rest').style.top];
        const first = place();
        screen.moveClock();
        assert.notEqual(place(), first);
        // The camera's own look at its picture is still there, a pixel nobody sees.
        const look = p.root.querySelector('#look');
        assert.ok(look && look.srcObject, 'the picture keeps playing behind the black page');
        dark.click();
        await sleep(30);
        assert.ok(document.body.classList.contains('lit') && p.text().includes('Stop'));
    } finally {
        p.close();
    }
});

test('names the microphone it has, and says when it is not the device’s own', async () => {
    const p = await opened({ door: { arrive: 'kept' }, devices: [A_DRAWN_MAC[0], A_DRAWN_MAC[2]], defaults: { defaultMicrophone: 'drawn-airpods' }, agent: MAC });
    try {
        await until(() => p.text().includes('Live'), 'the camera', 10_000);
        // Only a headset to listen through: its screen says so, in the line picked for it.
        assert.ok(p.text().includes('Microphone AirPods'), p.text());
        assert.ok(p.text().includes('Sound is coming from AirPods, not this Mac.'), p.text());
        assert.ok(!p.text().includes('Use this Mac’s microphone'), 'no button for a microphone that is not there');
        // The Mac's own appears: one tap takes it, and the line goes.
        p.devices.list.push(A_DRAWN_MAC[1]);
        p.devices.dispatchEvent(new Event('devicechange'));
        await until(() => p.text().includes('Microphone MacBook Pro Microphone'), "the Mac's own microphone, taken as soon as it is there");
        assert.ok(!p.text().includes('Sound is coming from'));
        // A person picks the headset themselves: it stands, the line says so, and the button takes it back.
        await p.tap('MacBook Pro Microphone');
        await p.tap('AirPods');
        await until(() => p.text().includes('Sound is coming from AirPods, not this Mac.'), 'the line for a headset someone picked');
        await p.tap('Use this Mac’s microphone');
        await until(() => !p.text().includes('Sound is coming from'), 'the line to go');
        assert.ok(p.text().includes('Microphone MacBook Pro Microphone'));
    } finally {
        p.close();
    }
});

test('ends by itself when its time is up, when the home ends it, and when it is gone', async () => {
    // Its time.
    const timed = await opened({ door: { arrive: 'kept', lastsMs: 2_500 } });
    try {
        await until(() => timed.text().includes('Live'), 'the camera', 10_000);
        await until(() => timed.text().startsWith('That’s the camera done.'), 'its time to be up', 10_000);
        assert.ok(timed.text().includes('The camera’s time was up.'));
        assert.equal([timed.devices.open.length, timed.door.left], [0, true]);
    } finally {
        timed.close();
    }
    // End now, from a viewer.
    const ended = await opened({ door: { arrive: 'kept' } });
    try {
        await until(() => ended.text().includes('Live'), 'the camera', 10_000);
        const viewer = await ended.viewer();
        await viewer.command({ name: 'end' });
        await until(() => ended.text().startsWith('That’s the camera done.'), 'the home to end it');
        assert.ok(ended.text().includes('A viewer ended the camera.'));
        assert.equal([ended.devices.open.length, ended.door.left], [0, true]);
    } finally {
        ended.close();
    }
    // The Worker closes its socket for good: it's no longer the home's.
    const gone = await opened({ door: { arrive: 'kept' } });
    try {
        await until(() => gone.text().includes('Live'), 'the camera', 10_000);
        gone.door.link.onState('gone');
        await until(() => gone.text().startsWith('That’s the camera done.'), 'it to be over');
        assert.equal([gone.devices.open.length, gone.door.left], [0, true]);
    } finally {
        gone.close();
    }
    // The same camera in another tab: this one stands down, and deletes nothing.
    const twice = await opened({ door: { arrive: 'kept' } });
    try {
        await until(() => twice.text().includes('Live'), 'the camera', 10_000);
        twice.door.link.onState('replaced');
        await until(() => twice.text() === 'This camera is running in another tab. Close this one.', 'it to stand down');
        assert.equal([twice.devices.open.length, twice.door.left], [0, false]);
    } finally {
        twice.close();
    }
});

test('says what it is where it cannot be a camera, and asks for nothing', async () => {
    const cases = [
        [{ door: { arrive: 'nothing' } }, 'To use this as a camera, scan the code a Pet Cam Pro viewer shows.'],
        [{ door: { arrive: 'over' } }, 'That’s the camera done. Close the page and it’s just a phone again. The camera’s time was up. If you let this page use the camera every time, you can take that back in the browser’s settings for this site.'],
        [{ mediaDevices: null }, "This browser can't be a camera. Use Chrome or Safari, up to date."],
        // Chrome before 120 can't be on AES-GCM: left out (decision 6).
        [{ agent: ANDROID.replace('Chrome/158', 'Chrome/119') }, "This browser can't be a camera. Use Chrome or Safari, up to date."],
    ];
    for (const [how, words] of cases) {
        const p = await opened(how);
        try {
            await until(() => p.text() === words, `the page to say "${words}" (it says: ${p.text()})`, 3_000);
            assert.equal(p.devices.asks, 0);
        } finally {
            p.close();
        }
    }
    // Turned down on the viewer.
    const refused = await opened({ door: { approves: 'when told' } });
    try {
        await until(() => refused.text().startsWith('862 673'), 'the code');
        refused.door.refuse('denied');
        await until(() => refused.text() === "The viewer didn't approve this camera.", 'the page to say so');
        assert.equal(refused.devices.asks, 0);
    } finally {
        refused.close();
    }
    // An iPhone is told the app is the better camera to keep; a phone that can't run it isn't.
    const iphone = await opened({ agent: IPHONE });
    try {
        await until(() => iphone.text().includes('is borrowing'), 'the approved page', 5_000);
        assert.ok(iphone.text().endsWith('Start the camera Keeping this iPhone as a camera? Use the Pet Cam Pro app instead.'), iphone.text());
    } finally {
        iphone.close();
    }
});

test('says so when the person says no, and starts at the next tap', async () => {
    const p = await opened();
    try {
        await until(() => p.text().includes('is borrowing'), 'the approved page', 5_000);
        const real = p.devices.getUserMedia.bind(p.devices);
        p.devices.getUserMedia = async () => {
            throw new DOMException('no', 'NotAllowedError');
        };
        await p.tap('Start the camera');
        await until(() => p.text().includes('The camera and microphone are off for this page.'), 'the page to say why');
        assert.ok(p.text().includes('Allow both, then tap Start the camera.'));
        p.devices.getUserMedia = real;
        await p.tap('Start the camera');
        await until(() => p.text().includes('Live'), 'the camera after a yes', 10_000);
    } finally {
        p.close();
    }
});

test("says nobody can watch while this device's clock is wrong, and has words where its pass named nobody", async () => {
    // Five minutes off the Worker's clock: a camera drops every signal two minutes off its own, so nobody could watch.
    const off = await opened({ door: { arrive: 'kept', startedBy: null, clockOffMs: 5 * 60_000 } });
    try {
        await until(() => off.text().includes('clock is wrong'), 'the page to say its clock is wrong', 10_000);
        const text = off.text();
        assert.ok(text.includes('This phone’s clock is wrong, so nobody can watch. Set the date and time.'), text);
        assert.ok(text.includes('Temporary camera') && !text.includes('Live'), text);
        // It says so, and never sets its clock by the Worker's: its end is still its pass's.
        assert.equal(off.app.camera().pass.endsAt, off.door.pass.endsAt);
    } finally {
        off.close();
    }
    const unnamed = await opened({ door: { startedBy: null } });
    try {
        await until(() => unnamed.text().includes('is being borrowed'), 'the approved page', 5_000);
        assert.ok(/^This phone is being borrowed as a camera until tomorrow, \d{1,2}:\d{2}( [AP]M)?\. Start the camera$/.test(unnamed.text()), unnamed.text());
    } finally {
        unnamed.close();
    }
});

const NO_PLAN = 'Nobody can watch: the Pet Cam Pro plan this camera runs on has ended.';

test("says nobody can watch while its home has no plan, ends nothing, and is live again when one is back", async () => {
    // The Worker here doesn't say its time: the page then says nothing of its clock.
    const p = await opened({ door: { arrive: 'kept', clockOffMs: null } });
    try {
        await until(() => p.text().includes('Live'), 'the camera', 10_000);
        const camera = p.app.camera();
        assert.equal([p.door.asked, camera.limits, camera.broadcaster.planCap, camera.clockOff], [1, { liveHeight: 1080, relayHeight: 720 }, 'auto', false], 'it asked what its plan allows as it started');
        const end = camera.pass.endsAt;
        // The plan runs out, as it happens.
        p.door.say({ type: 'limits_changed', limits: null });
        await until(() => p.text().includes(NO_PLAN), 'the page to say nobody can watch');
        assert.ok(!p.text().includes('Live') && p.text().includes('Stop'), p.text());
        // Nothing ends: it is still a camera, with its picture, its time and its place in the home.
        await sleep(300);
        assert.equal([camera.running, camera.ended, p.door.left, p.devices.open.length > 0, camera.pass.endsAt], [true, null, false, true, end]);
        // A plan is back, with its caps: live again with nothing done here, held to what the plan allows.
        p.door.say({ type: 'limits_changed', limits: { live_height: 720, relay_height: 720 } });
        await until(() => p.text().includes('Live') && !p.text().includes(NO_PLAN), 'the page to be live again');
        assert.equal([camera.broadcaster.planCap, camera.broadcaster.relayCap], ['medium', 'medium']);
        // A signal of its own that came back for want of a plan says the same, by another way.
        p.door.say({ type: 'error', code: 'plan_required', to: randomId(), session: randomId() });
        await until(() => p.text().includes(NO_PLAN), 'the page to say nobody can watch again');
        // Each time its socket opens it asks again: what changed while it was away came with no frame.
        p.door.limits = { liveHeight: 1080, relayHeight: 720 };
        camera.link.onState('open');
        await until(() => p.text().includes('Live') && p.door.asked === 2, 'it to ask again as its socket opens');
        assert.equal(camera.broadcaster.planCap, 'auto');
        // What isn't one of the Worker's frames changes nothing.
        p.door.say({ type: 'limits_changed', limits: { live_height: '720' } });
        p.door.say({ type: 'plan_changed', plan: null });
        await sleep(200);
        assert.ok(p.text().includes('Live'), p.text());
    } finally {
        p.close();
    }
    // Opened while its home has no plan, it says so from the start, under what this device can put right.
    const without = await opened({ door: { arrive: 'kept', limits: null } });
    try {
        await until(() => without.text().includes(NO_PLAN), 'the page to say nobody can watch', 10_000);
        assert.ok(!without.text().includes('Live'));
        assert.equal(without.app.camera().view().stopping, ['plan']);
        without.app.camera().link.isOpen = false;
        assert.equal(without.app.camera().view().stopping, ['offline', 'plan'], 'what can be put right here comes first');
        without.app.camera().link.isOpen = true;
    } finally {
        without.close();
    }
});

test('does nothing for any command but the three a member sends it', async () => {
    const file = await vectors('temporary-camera-v1');
    const p = await opened({ door: { arrive: 'kept' } });
    try {
        await until(() => p.text().includes('Live'), 'the camera', 10_000);
        const camera = p.app.camera();
        const viewer = await p.viewer();
        const before = { end: camera.pass.endsAt, using: JSON.stringify(camera.source.using()), text: p.text() };
        const statuses = () => p.relay.passed.filter((frame) => frame.type === 'status').length;
        const told = statuses();
        // Every command an app's camera takes and a page doesn't, and one no build knows.
        for (const never of file.sealed.commands.never_sent) await viewer.command(never);
        await until(() => statuses() >= told + file.sealed.commands.never_sent.length, 'a status after each, which is all it does for one');
        assert.equal([camera.running, camera.ended, camera.pass.endsAt, JSON.stringify(camera.source.using()), p.relay.stills.size, p.text()], [true, null, before.end, before.using, 0, before.text]);
        assert.equal(p.relay.dropped, []);
        // The three it takes are the file's three: stills, more time, and the end.
        assert.equal(file.sealed.commands.takes, ['peek', 'keep', 'end']);
        await viewer.command({ name: 'peek', value: 1 });
        await until(() => (p.relay.stills.get(p.door.cameraId) ?? []).length > 0, 'a still for a peek', 10_000);
        await viewer.command({ name: 'keep', value: before.end + 3_600_000 });
        await until(() => camera.pass.endsAt === before.end + 3_600_000, 'its end to move for a keep');
        await viewer.command({ name: 'end' });
        await until(() => p.text().startsWith('That’s the camera done.'), 'its end');
    } finally {
        p.close();
    }
});

test('reports the time it relayed once a minute, as an app’s camera does, and stops relaying when the hours are used up', async () => {
    const p = await opened({ door: { arrive: 'kept', relayReports: ['taken', 'unreachable', 'taken', 'refused', 'used up'] } });
    try {
        await until(() => p.text().includes('Live'), 'the camera', 10_000);
        const camera = p.app.camera();
        // No call in a test goes through a relay, so the sessions' count is stood in for.
        let relayed = [42.4, 0.3, 700, 0, 12, 30];
        camera.broadcaster.takeRelayedSeconds = () => relayed.shift() ?? 0;
        const ended = [];
        camera.broadcaster.setRelayAllowed = (allowed) => ended.push(allowed);

        await camera.reportRelay();
        assert.equal(p.door.reported, [42], 'whole seconds, and the rest waits');
        // The Worker couldn't be reached: what it would have said goes with the next report.
        await camera.reportRelay();
        assert.equal([p.door.reported.at(-1), Math.round(camera.unreportedRelay * 10) / 10], [1, 0.7]);
        // Never more than ten minutes in one report; the rest follows.
        await camera.reportRelay();
        assert.equal(p.door.reported.at(-1), 600);
        await camera.reportRelay();
        assert.equal(p.door.reported.at(-1), 101, 'the 100.7 left over; the Worker refused it for good, so it is not said again');
        await camera.reportRelay();
        assert.equal([p.door.reported.at(-1), ended], [12, [true, true, false]], 'the report that used the hours up ends what is relayed');
        // Nothing relayed, nothing reported.
        relayed = [0];
        await camera.reportRelay();
        assert.equal(p.door.reported.length, 5);
        // And what's left goes at its end, before it deletes itself.
        relayed = [7];
        await camera.end('here');
        assert.equal([p.door.reported.at(-1), p.door.left], [7, true]);
    } finally {
        p.close();
    }
});
