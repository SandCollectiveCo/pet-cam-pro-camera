// Every state of the page's screen, drawn from made-up facts, for looking
// at its words and its layout: /dev/screens.html?show=<name>. With no name
// it lists them. tools/shots.mjs takes a picture of each.
//
// Nothing runs behind these: no camera, no call, no socket. The picture in
// the lit states is the drawn one every dev page uses.

import { deviceKind } from '../src/device.js';
import { Screen } from '../src/ui/screen.js';
import { WORDS } from '../src/words.js';
import { A_DRAWN_PHONE, DrawnDevices } from './drawn.js';
import { realDevicesAreRefused, refuseRealDevices } from './guard.js';

refuseRealDevices();
if (!realDevicesAreRefused()) throw new Error("This page couldn't put its refusal of real cameras in place, so it runs nothing.");

const AGENTS = {
    phone: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15',
};

// A fixed moment, so a picture taken twice is the same picture: 2:10 in the afternoon, ending the same time tomorrow.
const NOW = new Date(2026, 10, 24, 14, 10, 0).getTime();
const TOMORROW = NOW + 86_400_000;

const phone = {
    camera: { name: 'Back Camera', deviceId: 'back', position: 'back', width: 1280, height: 720, frameRate: 30 },
    microphone: { name: 'Speakerphone', deviceId: 'speaker', whose: 'own' },
    cameras: [{ deviceId: 'back', name: 'Back Camera' }, { deviceId: 'front', name: 'Front Camera' }],
    microphones: [{ deviceId: 'speaker', name: 'Speakerphone' }, { deviceId: 'earpiece', name: 'Headset earpiece' }],
    hasOwnMicrophone: true,
};
const macWithHeadset = {
    camera: { name: 'MacBook Pro Camera', deviceId: 'mac', position: 'external', width: 1280, height: 720, frameRate: 30 },
    microphone: { name: 'AirPods', deviceId: 'airpods', whose: 'other' },
    cameras: [{ deviceId: 'mac', name: 'MacBook Pro Camera' }],
    microphones: [{ deviceId: 'macmic', name: 'MacBook Pro Microphone' }, { deviceId: 'airpods', name: 'AirPods' }],
    hasOwnMicrophone: true,
};
const view = (over = {}) => ({ startedBy: 'Maya Lopez', endsAt: TOMORROW, live: true, stopping: [], silent: false, watching: [], using: phone, charging: null, ended: null, ...over });
const on = { stop() {}, camera() {}, microphone() {}, ownMicrophone() {}, tryAgain() {} };
const camera = (over, how = {}) => ({ page: { kind: 'camera', view: view(over), on }, ...how });

/** Each state: what to show, on which device, and whether it's lit. */
const STATES = {
    'asking': { page: { kind: 'joining', code: null } },
    'code': { page: { kind: 'joining', code: '862 673' } },
    'approved': { page: { kind: 'ready', startedBy: 'Maya Lopez', endsAt: TOMORROW, starting: false, blocked: null, onStart() {} } },
    'approved-iphone': { page: { kind: 'ready', startedBy: 'Maya Lopez', endsAt: TOMORROW, starting: false, blocked: null, onStart() {} }, device: 'iphone' },
    'approved-mac': { page: { kind: 'ready', startedBy: 'Maya Lopez', endsAt: TOMORROW, starting: false, blocked: null, onStart() {} }, device: 'mac' },
    // A pass may name nobody: whoever started it gave the app no name.
    'approved-unnamed': { page: { kind: 'ready', startedBy: null, endsAt: TOMORROW, starting: false, blocked: null, onStart() {} } },
    'blocked': { page: { kind: 'ready', startedBy: 'Maya Lopez', endsAt: TOMORROW, starting: false, blocked: 'denied', onStart() {} } },
    'live': camera({}),
    'watched': camera({ watching: ['Maya’s iPhone'] }),
    'watched-by-three': camera({ watching: ['Maya’s iPhone', 'Kitchen iPad', 'Mac'] }),
    'watched-unnamed': camera({ watching: [null] }),
    // The worst names a home has: one at the 60-character limit, and one written right to left.
    'watched-long-names': camera({ startedBy: 'Maximiliano Alejandro Fernández-Villaverde de la Santísima T', watching: ['Wolfeschlegelsteinhausenbergerdorff’s iPhone 18 Pro Max (12)', 'نور الهدى'] }),
    'live-unnamed': camera({ startedBy: null }),
    'headset': camera({ using: macWithHeadset }, { device: 'mac' }),
    'choosing': camera({}, { choosing: 'microphone' }),
    'not-charging': camera({ charging: false }),
    'no-sound': camera({ silent: true, using: { ...phone, microphone: null, microphones: [], hasOwnMicrophone: false } }),
    'no-picture': camera({ live: false, stopping: ['stalled'] }),
    'offline': camera({ live: false, stopping: ['offline'] }),
    'clock-wrong': camera({ live: false, stopping: ['clock'] }),
    // The home's plan ran out while the camera lives: it stays a camera, and says nobody can watch.
    'no-plan': camera({ live: false, stopping: ['plan'] }),
    'camera-off': camera({ live: false, stopping: ['denied'] }),
    'stop-asks': camera({ watching: ['Maya’s iPhone'] }, { asking: true }),
    'dark': camera({}, { dark: true }),
    'dark-watched': camera({ watching: ['Maya’s iPhone', 'Kitchen iPad'] }, { dark: true }),
    'dark-long-names': camera({ startedBy: 'Maximiliano Alejandro Fernández-Villaverde de la Santísima T', watching: ['Wolfeschlegelsteinhausenbergerdorff’s iPhone 18 Pro Max (12)'] }, { dark: true }),
    'dark-offline': camera({ live: false, stopping: ['offline'] }, { dark: true }),
    'ended': { page: { kind: 'ended', why: 'here' } },
    'ended-time': { page: { kind: 'ended', why: 'time' } },
    'ended-from-a-viewer': { page: { kind: 'ended', why: 'home' } },
    'ended-mac': { page: { kind: 'ended', why: 'here' }, device: 'mac' },
    'elsewhere': { page: { kind: 'ended', why: 'elsewhere' } },
    'nothing': { page: { kind: 'message', text: WORDS.nothing } },
    'unsupported': { page: { kind: 'message', text: WORDS.unsupported } },
    'turned-down': { page: { kind: 'message', text: WORDS.turned.denied } },
    'code-too-old': { page: { kind: 'message', text: WORDS.turned.expired } },
};

const root = document.getElementById('page');
const name = new URLSearchParams(location.search).get('show');
const state = STATES[name];

if (!state) {
    // The list, for a person: a link to each.
    const list = document.createElement('ul');
    list.className = 'states';
    for (const each of Object.keys(STATES)) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `?show=${each}`;
        link.textContent = each;
        item.append(link);
        list.append(item);
    }
    root.replaceChildren(list);
    document.body.dataset.states = Object.keys(STATES).join(',');
} else {
    const clock = { now: () => NOW, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, random: () => 0.5 };
    const screen = new Screen(document, root, deviceKind({ userAgent: AGENTS[state.device ?? 'phone'], maxTouchPoints: state.device === 'mac' ? 0 : 5 }), clock);
    if (state.page.kind === 'camera') {
        // The drawn picture, where a camera's own look at its picture goes.
        const devices = new DrawnDevices(document, A_DRAWN_PHONE);
        screen.video.srcObject = devices.pictureStream();
    }
    screen.show(state.page);
    screen.lit = !state.dark;
    screen.asking = state.asking ?? false;
    screen.choosing = state.choosing ?? null;
    screen.draw();
    document.body.dataset.shown = name;
}
