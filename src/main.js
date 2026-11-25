// A release's entry: the one place the page is handed the browser's own
// pieces, the camera and the microphone among them, its storage, and the
// Worker it talks to. Nothing a test or a dev page runs loads this file;
// they hand the same page a drawn picture (dev/). Nothing here runs until
// `start()`, which the built page calls once, last.

import { runApp } from './app.js';
import { API, APP_VERSION, PAGE } from './config.js';
import { browserStore, memoryStore } from './crypto/store.js';
import { deviceKind } from './device.js';
import { workerDoor } from './join/worker-door.js';

export function start() {
    // Where the page was opened, read once. A camera invite's token rides in
    // the fragment: it comes out of the address first thing, before anything
    // else runs, whether or not this browser can be a camera.
    const opened = location.href;
    const fragment = opened.indexOf('#');
    if (fragment >= 0) history.replaceState(history.state, '', opened.slice(0, fragment));
    const timers = {
        now: () => Date.now(),
        at: () => performance.now() / 1000,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
    };
    return runApp({
        doc: document,
        root: document.getElementById('page'),
        door: workerDoor({
            api: API,
            page: PAGE,
            opened,
            // Where there's no storage (some private windows), it keeps what it has while the page is open, and no longer.
            store: globalThis.indexedDB ? browserStore() : memoryStore(),
            fetch: (url, init) => fetch(url, init),
            WebSocket: globalThis.WebSocket,
            clock: timers,
            model: deviceKind(navigator).name,
            appVersion: APP_VERSION,
        }),
        mediaDevices: navigator.mediaDevices,
        rtc: { RTCPeerConnection: globalThis.RTCPeerConnection, RTCRtpSender: globalThis.RTCRtpSender, MediaStream: globalThis.MediaStream },
        wakeLock: navigator.wakeLock,
        battery: typeof navigator.getBattery === 'function' ? () => navigator.getBattery() : undefined,
        agent: navigator,
        clock: timers,
        appVersion: APP_VERSION,
        secure: globalThis.isSecureContext === true,
        framed: globalThis.top !== globalThis.self,
    });
}
