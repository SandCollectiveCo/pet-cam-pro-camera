// The page's own source on the real door (src/join/worker-door.js), against
// a Worker on this Mac's loopback, with a drawn picture and a made tone: a
// dev build, for joining a test home on a local Worker by hand or from a
// script (scripts/web-camera-door/ in the apps' repository).
//
//   http://127.0.0.1:<dev port>/dev/live.html?worker=<port>[&run=<id>]
//
// The Worker is http://127.0.0.1:<port> and nothing else: this page never
// talks to production. Its address, query and all, is the page's address a
// camera invite's link starts with, and the Worker's CAMERA_PAGE_ORIGIN has
// to be this page's origin for it to answer. It reports what it shows to the
// dev server (/__report) under `run`, for whoever drives it.

import { runApp } from '../src/app.js';
import { browserStore } from '../src/crypto/store.js';
import { deviceKind } from '../src/device.js';
import { workerDoor } from '../src/join/worker-door.js';
import { A_DRAWN_PHONE, DrawnDevices } from './drawn.js';
import { realDevicesAreRefused, refuseRealDevices } from './guard.js';

refuseRealDevices();
if (!realDevicesAreRefused()) throw new Error("This page couldn't put its refusal of real cameras in place, so it runs nothing.");

// Where it was opened, read once, and the fragment out of the address at once, as a release's entry does.
const opened = location.href;
const fragment = opened.indexOf('#');
if (fragment >= 0) history.replaceState(history.state, '', opened.slice(0, fragment));

const query = new URLSearchParams(location.search);
// The Worker's port: from the address (/dev/live.html?worker=<port>), or, served as a release at an address of its own (dev/release.mjs), from the entry.
const port = Number(query.get('worker') ?? document.querySelector('meta[name="petcam-worker"]')?.getAttribute('content'));
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Name the local Worker: ?worker=<port>, on 127.0.0.1');
const api = `http://127.0.0.1:${port}`;
const run = query.get('run') ?? 'by-hand';
const page = `${location.origin}${location.pathname}${location.search}`;
const report = (body) => fetch(`/__report?run=${encodeURIComponent(run)}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});

const timers = {
    now: () => Date.now(),
    at: () => performance.now() / 1000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
};
const devices = new DrawnDevices(document, A_DRAWN_PHONE);
const door = workerDoor({
    api, page, opened, store: browserStore(), fetch: (url, init) => fetch(url, init), WebSocket: globalThis.WebSocket,
    clock: timers, model: deviceKind(navigator).name, appVersion: 'web (0)',
});
// A dev build talks to this Mac alone: the relay addresses are asked for as
// a release asks, and none is handed to a call that isn't on this Mac too
// (a local Worker lists Cloudflare's STUN server). Calls go by host candidates.
const listed = door.iceServers.bind(door);
door.iceServers = async (pass) => (await listed(pass)).filter((server) => server.urls.every((url) => /^(?:stun|turns?):127\.0\.0\.1(?::|\?|$)/.test(url)));
const app = runApp({
    doc: document, root: document.getElementById('page'), door, mediaDevices: devices,
    rtc: { RTCPeerConnection: globalThis.RTCPeerConnection, RTCRtpSender: globalThis.RTCRtpSender, MediaStream: globalThis.MediaStream },
    wakeLock: navigator.wakeLock, agent: navigator, clock: timers, appVersion: 'web (0)', secure: true,
});

// What it shows, each time that changes, and which camera it is.
let said = '';
new MutationObserver(() => {
    const text = document.getElementById('page').innerText.trim();
    if (text === said) return;
    said = text;
    report({ kind: 'shows', text, camera: app.camera()?.pass.cameraId ?? null, at: Date.now() });
}).observe(document.getElementById('page'), { childList: true, subtree: true, characterData: true });
report({ kind: 'opened', page, agent: navigator.userAgent });
