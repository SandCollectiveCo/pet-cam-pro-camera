// The page from the moment it opens: what this visit is, getting in, Start,
// the camera, and its end. Everything it touches of the browser is handed
// in by whoever starts it (src/main.js in a release), so the same flow runs
// in a test on a drawn picture and a made-up pass.

import { Camera } from './camera/camera.js';
import { VideoMonitor } from './capture/monitor.js';
import { DeviceSource } from './capture/source.js';
import { deviceKind } from './device.js';
import { Turned } from './join/door.js';
import { cleanName } from './names.js';
import { Screen } from './ui/screen.js';
import { WORDS } from './words.js';

/** The first Chrome whose calls can be on AES-GCM (decision 6): an older one can't meet a camera's terms. */
const FIRST_CHROME = 120;
/** The first Safari the first version takes: before 16.4 a page can't keep a screen awake. */
const FIRST_SAFARI = [16, 4];

/**
 * Whether this browser is one the first version leaves out, by what it says
 * it is. A browser that hasn't passed its check is left out (decision 6):
 * Chrome before 120, Safari before 16.4, and Firefox, which hasn't yet been
 * on a call with the app. On an iPhone or iPad every browser is Safari's
 * engine at the system's version, so the system's version is what counts.
 * What a browser says it is can be wrong, and nothing rests on it: every
 * call is still held to its terms by the connection itself (src/rtc/).
 * @param {{ userAgent?: string }} agent
 */
export function isLeftOut(agent) {
    const ua = agent.userAgent ?? '';
    if (/\b(?:Firefox|FxiOS)\//.test(ua)) return true;
    const chrome = /\bChrom(?:e|ium)\/(\d+)/.exec(ua);
    if (chrome) return Number(chrome[1]) < FIRST_CHROME;
    const version = /\b(?:iPhone|iPad|iPod)\b[^)]*?\bOS (\d+)_(\d+)/.exec(ua) ?? /\bVersion\/(\d+)\.(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//.exec(ua);
    if (version) return Number(version[1]) < FIRST_SAFARI[0] || (Number(version[1]) === FIRST_SAFARI[0] && Number(version[2]) < FIRST_SAFARI[1]);
    return false;
}

/**
 * @typedef {object} World
 * @property {Document} doc
 * @property {HTMLElement} root
 * @property {import('./join/door.js').Door} door
 * @property {import('./capture/source.js').MediaDevicesLike | undefined} mediaDevices the browser's cameras and microphones, or a test's drawn ones
 * @property {import('./rtc/peer.js').Rtc} rtc
 * @property {{ request: (type: 'screen') => Promise<any> } | undefined} wakeLock
 * @property {(() => Promise<any>) | undefined} battery
 * @property {{ userAgent?: string, maxTouchPoints?: number }} agent
 * @property {{ now: () => number, at: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void, setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (id: any) => void }} clock
 * @property {string} appVersion what this release's camera says it is: "web (1)"
 * @property {boolean} secure whether the page is somewhere a browser gives a page a camera at all
 * @property {boolean} [framed] whether the page is shown inside another page: it then does nothing. Its host can't send the header that forbids framing, and a policy written into a page can't either, so the page refuses for itself
 * @property {import('./rtc/terms.js').Terms} [terms] a test's alone
 */

/** Whether this browser can be a camera on the apps' terms. @param {World} world */
export function canBeACamera(world) {
    if (isLeftOut(world.agent)) return false;
    if (world.framed) return false;
    return Boolean(world.secure && world.mediaDevices && typeof world.mediaDevices.getUserMedia === 'function' && typeof world.rtc.RTCPeerConnection === 'function' && world.rtc.RTCRtpSender && typeof world.rtc.MediaStream === 'function' && globalThis.crypto?.subtle);
}

/**
 * Runs the page. It comes back at once with the screen; what follows (being
 * let in, Start, the camera, its end) happens as it happens.
 * @param {World} world
 * @returns {{ screen: Screen, camera: () => Camera | null }} for a test to look at
 */
export function runApp(world) {
    const device = deviceKind(world.agent);
    const screen = new Screen(world.doc, world.root, device, world.clock);
    world.doc.title = WORDS.title;
    /** @type {Camera | null} */
    let camera = null;
    const handle = { screen, camera: () => camera };

    if (!canBeACamera(world)) {
        screen.show({ kind: 'message', text: WORDS.unsupported });
        return handle;
    }
    const arrive = async () => {
        const arrival = await world.door.arrive();
        if (arrival.kind === 'nothing') screen.show({ kind: 'message', text: WORDS.nothing });
        else if (arrival.kind === 'over') {
            // Its time ran out while the page was shut, or a viewer ended it meanwhile: either way it's over, and nothing of it stays.
            await world.door.leave().catch(() => {});
            screen.show({ kind: 'ended', why: arrival.why === 'gone' ? 'gone' : 'over' });
        } else if (arrival.kind === 'kept') {
            // Opened again within its time, it carries on, with no tap where the browser still allows the camera.
            camera = makeCamera(world, screen, arrival.pass, arrival.seen);
            await begin(world, screen, camera, true);
        } else {
            screen.show({ kind: 'joining', code: null });
            let pass;
            try {
                pass = await world.door.join((code) => screen.show({ kind: 'joining', code }));
            } catch (error) {
                screen.show({ kind: 'message', text: error instanceof Turned ? WORDS.turned[error.why] : WORDS.turned.expired });
                return;
            }
            camera = makeCamera(world, screen, pass, {});
            ready(world, screen, camera, null);
        }
    };
    arrive().catch(() => screen.show({ kind: 'message', text: WORDS.turned.expired }));
    return handle;
}

/** The approved page: whose camera this will be, until when, and Start the camera. */
function ready(world, screen, camera, blocked) {
    screen.show({ kind: 'ready', startedBy: cleanName(camera.pass.startedBy), endsAt: camera.pass.endsAt, starting: false, blocked, onStart: () => begin(world, screen, camera, false) });
}

/** Starts the camera, which is where the browser asks the person. */
async function begin(world, screen, camera, carryingOn) {
    screen.show({ kind: 'ready', startedBy: cleanName(camera.pass.startedBy), endsAt: camera.pass.endsAt, starting: true, blocked: null, onStart: () => {} });
    try {
        await camera.start();
    } catch (error) {
        const name = error?.name;
        const blocked = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing' : 'failed';
        // A page opened again that isn't let have the camera by itself just waits for the tap.
        ready(world, screen, camera, carryingOn && blocked === 'denied' ? null : blocked);
    }
}

function makeCamera(world, screen, pass, seen) {
    const monitor = new VideoMonitor(screen.video, world.doc);
    const camera = new Camera({
        pass, seen, door: world.door, monitor,
        source: new DeviceSource(/** @type {import('./capture/source.js').MediaDevicesLike} */ (world.mediaDevices), deviceKind(world.agent).kind),
        around: { doc: world.doc, wakeLock: world.wakeLock, now: world.clock.now, setInterval: world.clock.setInterval, clearInterval: world.clock.clearInterval, battery: world.battery },
        rtc: world.rtc, clock: world.clock, appVersion: world.appVersion, terms: world.terms,
        onView: (view) => {
            if (view.ended) screen.show({ kind: 'ended', why: view.ended.why });
            else {
                screen.show({
                    kind: 'camera', view,
                    on: {
                        stop: () => camera.stop(),
                        camera: (deviceId) => camera.source.useCamera(deviceId).catch(() => {}),
                        microphone: (deviceId) => camera.source.useMicrophone(deviceId).catch(() => {}),
                        ownMicrophone: () => camera.source.useOwnMicrophone().catch(() => {}),
                        tryAgain: () => camera.tryAgain(),
                    },
                });
            }
        },
    });
    return camera;
}
