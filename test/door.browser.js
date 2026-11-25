// The whole page through the real door (src/join/worker-door.js), in a
// browser: the browser's own storage, a drawn picture, a stand-in Worker
// that plays the home's member (dev/worker.js), and a stand-in viewer that
// holds the camera's keys as a member does. From a camera invite's link to
// its six digits, Approve, Start and live; an offer signed under its own
// keys; the same camera after a reload, with no tap; and its end, by a
// viewer, by its time, and while the page was shut.

import { ANY_SUITE_FOR_TESTS } from '../dev/any-suite.js';
import { A_DRAWN_PHONE, DrawnDevices } from '../dev/drawn.js';
import { Relay } from '../dev/relay.js';
import { StandInViewer } from '../dev/viewer.js';
import { StandInWorker } from '../dev/worker.js';
import { runApp } from '../src/app.js';
import { SealContext } from '../src/crypto/keys.js';
import { randomId } from '../src/crypto/primitives.js';
import { browserStore } from '../src/crypto/store.js';
import { KEPT_KEY } from '../src/join/kept.js';
import { workerDoor } from '../src/join/worker-door.js';
import { assert, sleep, suite, test, until } from './lib/harness.js';

suite('the page through the door');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const PAGE = 'https://camera.example/';
const SOON = { askEveryMs: 25, askAtMostEveryMs: 100, askForAtMostMs: 20_000, leaveWaitsMs: 500, answerWithinMs: 2_000 };
const timers = () => ({
    now: () => Date.now(),
    at: () => performance.now() / 1000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
});

/** A home on a stand-in Worker, with a camera invite, and the browser's storage emptied for the page. */
async function aHome() {
    const relay = new Relay();
    const worker = new StandInWorker({ relay });
    const home = await worker.home();
    const invite = worker.cameraInvite(home);
    await invite.ready;
    await browserStore().clear();
    return { relay, worker, home, invite, pages: [] };
}

/** The page, opened at `opened` in a corner of this one, on the real door. @param {Awaited<ReturnType<typeof aHome>>} h @param {string} opened */
function openPage(h, opened) {
    const devices = new DrawnDevices(document, A_DRAWN_PHONE);
    const root = document.createElement('main');
    root.className = 'page-under-test';
    document.body.append(root);
    const clock = timers();
    const door = workerDoor({ api: h.worker.api, page: PAGE, opened, store: browserStore(), fetch: h.worker.fetch, WebSocket: h.worker.WebSocket, clock, model: 'Android phone', appVersion: 'web (0)', timing: SOON });
    const app = runApp({
        doc: document, root, door, mediaDevices: devices, rtc: { RTCPeerConnection, RTCRtpSender, MediaStream }, wakeLock: navigator.wakeLock,
        agent: { userAgent: ANDROID, maxTouchPoints: 5 }, clock, appVersion: 'web (0)', secure: true, terms: ANY_SUITE_FOR_TESTS,
    });
    const text = () => {
        const pieces = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim() !== '') pieces.push(node.textContent.trim());
        return pieces.join(' ');
    };
    const tap = async (label) => {
        const button = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
        assert.ok(button, `a button that says "${label}" (the page says: ${text()})`);
        button.click();
        await sleep(30);
    };
    const page = {
        door, devices, root, app, text, tap,
        close() {
            const camera = app.camera();
            if (camera?.running) camera.end('elsewhere');
            devices.close();
            root.remove();
            document.body.classList.remove('lit');
            document.title = 'Pet Cam Pro camera page: tests';
        },
    };
    h.pages.push(page);
    return page;
}

/** The page asks, a member answers and shows its code, the page shows the same, and the member approves. @param {Awaited<ReturnType<typeof aHome>>} h @param {ReturnType<typeof openPage>} p @param {Parameters<StandInWorker['approveOn']>[1]} [how] */
async function letIn(h, p, how) {
    await until(() => p.text() === 'Asking the viewer…', 'the page to say it is asking', 5_000, 5);
    await until(() => h.worker.requestOn(h.invite.id), 'the page to ask', 8_000, 10);
    h.worker.answerOn(h.invite.id);
    const code = await until(() => h.worker.codeOn(h.invite.id), "the member's code", 8_000, 10);
    await until(() => p.text() === `${code} Tap Approve on the viewer if it shows this code.`, 'the page to show the same six digits', 8_000, 10);
    const memberKeys = await h.worker.approveOn(h.invite.id, how);
    await until(() => p.text().includes('is borrowing this phone as a camera'), 'the approved page', 8_000, 10);
    return { code, memberKeys, cameraId: h.worker.requestOn(h.invite.id).deviceId };
}

test('gets into a home through the Worker, is the same camera after a reload, and ends when a viewer ends it', async () => {
    const h = await aHome();
    try {
        const p = openPage(h, h.invite.link(PAGE));
        assert.equal(p.devices.asks, 0);
        const { memberKeys, cameraId } = await letIn(h, p, { name: 'Maya Lopez' });
        assert.ok(/^Maya Lopez is borrowing this phone as a camera until tomorrow, \d{1,2}:\d{2}( [AP]M)?\. Start the camera$/.test(p.text()), p.text());
        assert.equal(p.devices.asks, 0, 'no camera is asked for before someone is let in and taps Start');
        // What the browser keeps is the camera: its keys, never its secret or the link's token.
        const kept = await browserStore().get(KEPT_KEY);
        assert.ok(kept?.camera && kept.asking === null && kept.deviceId === cameraId);
        for (const key of kept.camera.keys.flatMap((k) => [k.box, k.media, k.signal])) assert.equal(key.extractable, false);
        assert.equal(kept.deviceKey.privateKey.extractable, false);

        await p.tap('Start the camera');
        await until(() => p.text().includes('Live'), 'the camera to be live', 15_000);
        assert.equal(h.worker.sockets.get(cameraId)?.appVersion, 'web (0)', 'its socket opened with a ticket, saying what it runs');
        // It says how it is, sealed with its own keys, and a member opens that.
        const status = await until(() => h.relay.statuses.get(cameraId), "the camera's status", 10_000);
        const said = await memberKeys.openMessage(status, SealContext.status(cameraId), { fresh: true });
        assert.equal([said.viewers, said.app_version, said.ends_at], [0, 'web (0)', p.app.camera().pass.endsAt]);

        // A viewer asks to watch: the offer comes signed under the camera's own keys, and the viewer's copy of them checks it.
        const viewerId = randomId();
        const viewer = new StandInViewer({ id: viewerId, cameraId, keys: memberKeys, link: h.relay.join(viewerId), doc: document });
        await viewer.watch({ viewer_name: 'Maya’s iPhone' });
        await until(() => viewer.offer, "the camera's offer", 10_000);
        assert.equal(viewer.offerSigned, true, 'signed with the camera’s own signal key');

        // Reloaded: the same page opened again with no link. It is the same camera, live with no tap, and the first stands down.
        const again = openPage(h, PAGE);
        await until(() => again.text().includes('Live'), 'the page opened again to carry on as the camera, with no tap', 15_000);
        assert.equal(again.app.camera().pass.cameraId, cameraId);
        await until(() => p.text() === 'This camera is running in another tab. Close this one.', 'the first to stand down', 8_000);
        assert.ok(h.worker.devices.has(cameraId), 'standing down ends nothing');
        // Still the home's: what it says now opens with the same keys.
        await until(async () => {
            const latest = h.relay.statuses.get(cameraId);
            return latest !== status && (await memberKeys.openMessage(latest, SealContext.status(cameraId), { fresh: true })).app_version === 'web (0)';
        }, 'a status from the page opened again', 10_000);

        // A viewer ends it: the page says so, lets go of its camera, and its device and everything it kept go.
        await viewer.command({ name: 'end' });
        await until(() => again.text().startsWith('That’s the camera done.'), 'the page at its end', 10_000);
        viewer.close();
        assert.ok(again.text().includes('A viewer ended the camera.'), again.text());
        assert.equal(again.devices.open.length, 0, 'the camera and the microphone are let go of');
        await until(() => !h.worker.devices.has(cameraId), 'its device deleted on the Worker', 5_000);
        assert.equal(await browserStore().get(KEPT_KEY), undefined, 'and nothing kept in the browser');
        // Opened once more, it is nothing: a new camera takes a new code.
        const after = openPage(h, PAGE);
        await until(() => after.text() === 'To use this as a camera, scan the code a Pet Cam Pro viewer shows.', 'a page with nothing kept', 5_000);
    } finally {
        for (const page of h.pages) page.close();
        await browserStore().clear();
    }
});

test('ends at its end, and a camera the home ended while the page was shut says so when it is opened again', async () => {
    const timed = await aHome();
    try {
        const p = openPage(timed, timed.invite.link(PAGE));
        const { cameraId } = await letIn(timed, p, { endsAt: Date.now() + 6_000 });
        await p.tap('Start the camera');
        await until(() => p.text().includes('Live'), 'the camera to be live', 15_000);
        await until(() => p.text().startsWith('That’s the camera done.'), 'the camera to end at its time', 15_000);
        assert.ok(p.text().includes('The camera’s time was up.'), p.text());
        await until(() => !timed.worker.devices.has(cameraId), 'its device deleted on the Worker', 5_000);
        assert.equal(await browserStore().get(KEPT_KEY), undefined);
    } finally {
        for (const page of timed.pages) page.close();
    }
    const shut = await aHome();
    try {
        const p = openPage(shut, shut.invite.link(PAGE));
        const { cameraId } = await letIn(shut, p);
        // The page is shut before anyone taps Start, and a viewer ends the camera meanwhile.
        p.close();
        shut.worker.endCamera(cameraId);
        const again = openPage(shut, PAGE);
        await until(() => again.text().startsWith('That’s the camera done.'), 'the page opened again to say it is over', 8_000);
        assert.ok(again.text().includes('A viewer ended the camera.'), again.text());
        assert.equal([again.devices.asks, await browserStore().get(KEPT_KEY)], [0, undefined], 'no camera asked for, nothing kept');
    } finally {
        for (const page of shut.pages) page.close();
        await browserStore().clear();
    }
});

test('says its time was up when the Worker ends it at its time a moment before the page sees it', async () => {
    // The Worker ends a temporary camera by its own copy of the end, on its own clock: here a minute ahead of this page's.
    const h = await aHome();
    try {
        const p = openPage(h, h.invite.link(PAGE));
        const { cameraId } = await letIn(h, p, { endsAt: Date.now() + 60_000 });
        await p.tap('Start the camera');
        await until(() => p.text().includes('Live'), 'the camera to be live', 15_000);
        await until(() => h.worker.sockets.has(cameraId), 'its socket', 10_000);
        h.worker.endCamera(cameraId);
        await until(() => p.text().startsWith('That’s the camera done.'), 'the page at its end', 10_000);
        assert.ok(p.text().includes('The camera’s time was up.'), p.text());
        assert.equal([p.devices.open.length, await browserStore().get(KEPT_KEY)], [0, undefined]);
        // Ended by a viewer long before its end, it says so instead (the first test, by `end`; here by the Worker, as End now does).
        const early = await aHome();
        const q = openPage(early, early.invite.link(PAGE));
        const { cameraId: other } = await letIn(early, q);
        await q.tap('Start the camera');
        await until(() => q.text().includes('Live') && early.worker.sockets.has(other), 'the second camera live', 15_000);
        early.worker.endCamera(other);
        await until(() => q.text().startsWith('That’s the camera done.'), 'the second page at its end', 10_000);
        assert.ok(q.text().includes('A viewer ended the camera.'), q.text());
        for (const page of early.pages) page.close();
    } finally {
        for (const page of h.pages) page.close();
        await browserStore().clear();
    }
});

test('says when a member says no, and keeps nothing of it', async () => {
    const h = await aHome();
    try {
        const p = openPage(h, h.invite.link(PAGE));
        await until(() => h.worker.requestOn(h.invite.id), 'the page to ask', 8_000, 10);
        const cameraId = h.worker.requestOn(h.invite.id).deviceId;
        h.worker.denyOn(h.invite.id);
        await until(() => p.text() === 'The viewer didn’t approve this camera.' || p.text() === "The viewer didn't approve this camera.", 'the page to say so', 8_000, 10);
        await until(() => !h.worker.devices.has(cameraId), 'its device deleted on the Worker', 5_000);
        assert.equal([p.devices.asks, await browserStore().get(KEPT_KEY)], [0, undefined]);
    } finally {
        for (const page of h.pages) page.close();
        await browserStore().clear();
    }
});
