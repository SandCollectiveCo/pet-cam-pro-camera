// The camera's sending half, driven from outside the page: for a call with
// something that isn't another page in this browser, which is how the page
// is tried against the real apps (the apps' repository has the other half,
// scripts/web-camera-bridge/).
//
// The page here does only what src/rtc/ does: the sessions, on the page's
// real terms (AES-GCM or nothing). It holds no key at all. Whoever drives it
// does the signalling, sealed and signed, somewhere else, and tells the
// page in the clear over this computer's loopback what a viewer asked and
// answered. The picture is drawn and the sound is a made tone.
//
//   /dev/driven.html?run=<id>     takes what it's told from /__told, says
//                                 what happens to /__report

import { DeviceSource } from '../src/capture/source.js';
import { CameraBroadcaster } from '../src/rtc/broadcaster.js';
import { TERMS } from '../src/rtc/terms.js';
import { A_DRAWN_PHONE, DrawnDevices } from './drawn.js';
import { realDevicesAreRefused, refuseRealDevices } from './guard.js';

refuseRealDevices();
if (!realDevicesAreRefused()) throw new Error("This page couldn't put its refusal of real cameras in place, so it runs nothing.");

const run = new URLSearchParams(location.search).get('run') ?? 'by-hand';
const say = document.getElementById('log');
const report = (body) => fetch(`/__report?run=${encodeURIComponent(run)}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
const line = (text) => {
    say.textContent = `${say.textContent}${text}\n`.slice(-4000);
};

const devices = new DrawnDevices(document, A_DRAWN_PHONE);
// ?tone=0.002 makes the tone near silent: what watches this page may play it aloud.
const tone = Number(new URLSearchParams(location.search).get('tone'));
if (tone > 0 && tone <= 1) devices.toneGain = tone;
const source = new DeviceSource(devices, 'android_phone');
await source.start();
document.getElementById('picture').srcObject = new MediaStream([source.video]);

let iceServers = [];
const clock = {
    now: () => Date.now(),
    at: () => performance.now() / 1000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
};
const broadcaster = new CameraBroadcaster({
    tracks: () => ({ video: source.video, audio: source.audio, shortSide: 720 }),
    iceServers: async () => iceServers,
    // What the sessions hand over to be signed, sealed and sent: out to whoever drives the page.
    send: (viewer, session, payload) => {
        report({ kind: 'signal', viewer, session, payload });
    },
    rtc: { RTCPeerConnection, RTCRtpSender, MediaStream },
    clock,
    // The page's real terms: nothing is sent unless the call agreed AES-GCM.
    terms: TERMS,
    onWatchers: (watchers) => {
        line(`watching: ${watchers.length}`);
        report({ kind: 'watchers', watchers });
    },
});

/** How each session stands, from its connection's own report. */
async function sessions() {
    const out = [];
    for (const peer of broadcaster.peers.values()) {
        const reading = await peer.read().catch(() => null);
        out.push({
            session: peer.session, viewer: peer.viewer, connected: peer.hasConnected, locked: peer.locked, encryption: peer.encryption, playing: peer.playing,
            listening: peer.listening, wantsVideo: peer.wantsVideo, cap: peer.viewerCap, step: peer.applied?.step ?? null, sending: peer.applied?.video ?? null,
            leftOutBy: peer.stoppedByApi ? "the browser's own call" : 'going over the offer', reading,
            // Whether its viewer's watch left it the relay, and for one made without, the path it's judged by.
            relay: peer.usesRelay, ...(peer.usesRelay ? {} : { path: peer.selectedPair, relayPortsLeftOut: [...peer.relayPortsLeftOut] }),
            channel: peer.channel.readyState, state: peer.pc.connectionState,
        });
    }
    return out;
}
setInterval(async () => report({ kind: 'stats', at: Date.now(), tone: devices.toneRuns, sessions: await sessions(), refused: broadcaster.refused }), 1_000);

/** @param {any} told */
async function act(told) {
    line(`told: ${told.cmd}${told.session ? ` ${told.session.slice(0, 8)}` : ''}`);
    if (told.cmd === 'ice') iceServers = told.servers;
    else if (told.cmd === 'watch') await broadcaster.watch(told.viewer, told.session, told.terms, told.name ?? null);
    else if (told.cmd === 'answer') await broadcaster.answer(told.viewer, told.session, told.sdp);
    else if (told.cmd === 'refuse') broadcaster.refuse(told.session);
    else if (told.cmd === 'candidate') await broadcaster.candidate(told.viewer, told.session, told.candidate);
    else if (told.cmd === 'bye') broadcaster.bye(told.viewer, told.session);
    else if (told.cmd === 'left') broadcaster.viewerLeft(told.viewer);
    else if (told.cmd === 'end') {
        broadcaster.endAll();
        source.stop();
        devices.close();
        await report({ kind: 'ended' });
        line('This run is over. This tab can be closed.');
        window.close();
    }
}

await report({ kind: 'ready', agent: navigator.userAgent });
line(`ready as run ${run}: a drawn picture and a made tone, on the page's real terms`);
for (let after = 0; ;) {
    try {
        const told = await (await fetch(`/__told?run=${encodeURIComponent(run)}&after=${after}`)).json();
        for (const one of told) {
            after += 1;
            await act(one).catch((error) => report({ kind: 'error', doing: one.cmd, error: `${error?.name}: ${error?.message}` }));
        }
    } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}
