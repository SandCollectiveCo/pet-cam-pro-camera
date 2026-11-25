// A temporary camera, running: it captures, keeps itself awake, sends to
// whoever watches, says how it is, hands a grid tile its stills, and ends
// when its time is up, when the home ends it, or at Stop on its own screen
// (docs/WEB-CAMERA.md §§ 3 to 5).
//
// Everything it needs of the world is handed to it: the pass and the door
// it came through, where its picture comes from, the page around it. So a
// test runs the whole of it on a drawn picture, a stand-in socket and a
// made-up pass.

import { Keeper } from '../capture/keeper.js';
import { goneBecause } from '../join/door.js';
import { cleanName } from '../names.js';
import { CameraBroadcaster } from '../rtc/broadcaster.js';
import { planCap } from '../rtc/ladder.js';
import { SeenCommands, peekSeconds } from '../wire/command.js';
import { STUN_ONLY } from '../wire/frames.js';
import { BYE } from '../wire/signal.js';
import { STATUS_REFRESH_MS, cameraStatus, shownStatus } from '../wire/status.js';
import { CameraSignals } from './signals.js';

/** A clock further than this from the Worker's can't be watched: a camera
 * drops a signal two minutes off its own clock, so the page says so well
 * before that. */
export const CLOCK_OFF_MS = 90_000;
/** A still goes at most this often, however many ask. */
const STILL_AT_MOST_EVERY_MS = 750;
/** A device taking stills is named on the screen a moment past its ask, as a grid tile's next second's ask comes. */
const PEEK_NAMED_FOR_MS = 1_500;
const LOOK_EVERY_MS = 1_000;
/** The longest its end waits for a last word to the Worker before it goes on to delete itself. */
const LAST_REPORT_WAITS_MS = 3_000;
/** How often a camera reports the live video it relayed, and the most one report says (docs/API.md, Plans). */
export const RELAY_REPORT_EVERY_MS = 60_000;
export const RELAY_REPORT_MAX_SECONDS = 600;

/**
 * What the camera's screen shows, whole: the screen is drawn from this and
 * nothing else.
 * @typedef {object} CameraView
 * @property {string | null} startedBy the person who started it, where its pass named one
 * @property {number} endsAt
 * @property {boolean} live seeing, connected, its clock right, and its home's plan allowing it
 * @property {('stalled' | 'denied' | 'missing' | 'failed' | 'offline' | 'clock' | 'plan')[]} stopping what's stopping it, what can be put right on this device first; `plan`: the home's plan ran out, so nobody can watch, and nothing ends
 * @property {boolean} silent it has no sound to send: a picture without sound is still live, and its screen says so
 * @property {(string | null)[]} watching one name a device, null where its call didn't say
 * @property {import('../capture/source.js').Using} using
 * @property {boolean | null} charging where the browser says
 * @property {{ why: 'time' | 'home' | 'here' | 'gone' | 'elsewhere' } | null} ended
 */

export class Camera {
    /**
     * @param {{
     *   pass: import('../join/door.js').Pass,
     *   seen?: Record<string, number>,
     *   door: import('../join/door.js').Door,
     *   source: import('../capture/source.js').DeviceSource,
     *   monitor: import('../capture/monitor.js').VideoMonitor,
     *   around: import('../capture/keeper.js').Around & { battery?: () => Promise<{ level: number, charging: boolean, addEventListener?: (type: string, listener: () => void) => void } | null> },
     *   rtc: import('../rtc/peer.js').Rtc,
     *   clock: { now: () => number, at: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void, setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (id: any) => void },
     *   appVersion: string,
     *   terms?: import('../rtc/terms.js').Terms,
     *   onView: (view: CameraView) => void,
     * }} options
     */
    constructor(options) {
        this.options = options;
        this.pass = options.pass;
        this.door = options.door;
        this.source = options.source;
        this.clock = options.clock;
        this.onView = options.onView;
        this.running = false;
        /** @type {CameraView['ended']} */
        this.ended = null;
        this.link = null;
        this.signals = null;
        this.battery = null;
        this.clockOff = false;
        /** What the home's plan allows this camera, as the Worker last said: undefined until it has, null while there's no plan that allows it. @type {import('../wire/frames.js').Limits | null | undefined} */
        this.limits = undefined;
        this.learning = false;
        this.lastStatus = null;
        this.statusTimer = null;
        this.peekUntil = 0;
        this.lastStillAt = 0;
        /** Devices taking stills now, and until when each is named. @type {Map<string, number>} */
        this.peekers = new Map();
        /** Relayed seconds no report has carried yet, and when the last one went. */
        this.unreportedRelay = 0;
        this.lastRelayReport = 0;
        this.lastView = '';
        this.seen = new SeenCommands(options.seen);
        this.keeper = new Keeper(options.source, options.monitor, options.around, () => this.changed());
        this.broadcaster = new CameraBroadcaster({
            tracks: () => {
                const camera = this.source.using().camera;
                const shortSide = camera?.width && camera?.height ? Math.min(camera.width, camera.height) : 720;
                return { video: this.source.video, audio: this.source.audio, shortSide };
            },
            iceServers: () => this.door.iceServers(this.pass).catch(() => STUN_ONLY.map((server) => ({ urls: server.urls }))),
            send: (viewer, session, payload) => {
                this.signals?.send(viewer, session, payload).catch(() => {});
            },
            rtc: options.rtc,
            clock: options.clock,
            terms: options.terms,
            onWatchers: () => this.changed(),
            // No Talk in the first version: nothing a viewer sends is ever
            // played, and the page has nothing to play it with. Its offer
            // is still an app camera's, sound both ways, so that nothing
            // about a call has to change when Talk comes.
        });
        this.stopListening = null;
    }

    /** Asks for the camera and the microphone (where the browser asks the
     * person), and from then on it's a camera. Throws what the browser
     * throws if they say no. */
    async start() {
        if (this.running || this.ended) return;
        await this.source.start();
        this.running = true;
        this.stopListening = this.source.listen((what) => {
            if (what === 'tracks') this.broadcaster.tracksChanged();
            this.changed();
        });
        this.keeper.start();

        this.link = this.door.connect(this.pass);
        this.signals = new CameraSignals({
            keys: this.pass.keys, cameraId: this.pass.cameraId, link: this.link, broadcaster: this.broadcaster, now: this.clock.now, seen: this.seen,
            onCommand: (from, command) => this.command(from, command),
            onSeen: (kept) => {
                this.door.keep(this.pass, kept).catch(() => {});
            },
            // The home's plan ran out, is back, or changed its caps, as it happens.
            onLimits: (limits) => this.setLimits(limits),
            // A signal of its own came back for want of a plan: the same news, by another way.
            onPlanRequired: () => this.setLimits(null),
        });
        this.link.onState = (state) => {
            // The Worker has no such camera now: at its time, by the Worker's copy of the end, or ended by someone in the home.
            if (state === 'gone') this.end(goneBecause(this.pass.endsAt, this.clock.now()), { deviceGone: true });
            else if (state === 'replaced') this.end('elsewhere');
            else {
                // Each time its socket opens it asks what its plan allows again: what changed while it was away came with no frame.
                if (state === 'open') this.learnAllowance();
                this.changed();
            }
        };
        this.lastRelayReport = this.clock.now();
        this.statusTimer = this.clock.setInterval(() => this.look(), LOOK_EVERY_MS);
        this.learnAllowance();
        this.learnBattery();
        this.changed();
    }

    /** What the home's plan allows, and whether this device's clock can be
     * trusted: asked as it starts and each time its socket opens. */
    async learnAllowance() {
        if (this.learning) return;
        this.learning = true;
        try {
            const allowance = await this.door.allowance(this.pass);
            if (!this.running) return;
            this.broadcaster.setRelayAllowed(allowance.relay);
            // Said, never corrected: the page doesn't set its clock by the Worker's, nor its end.
            this.clockOff = allowance.serverNow !== null && Math.abs(allowance.serverNow - this.clock.now()) > CLOCK_OFF_MS;
            this.setLimits(allowance.limits);
        } catch {
            // Without an answer it runs on what it has.
        } finally {
            this.learning = false;
        }
    }

    /** What the home's plan allows this camera now. With no plan (null)
     * nobody can watch, and its screen says so; nothing ends: its time runs
     * on, a call already connected runs on, and a plan back in force makes
     * it watchable again with nothing done here.
     * @param {import('../wire/frames.js').Limits | null} limits */
    setLimits(limits) {
        if (!this.running) return;
        this.limits = limits;
        if (limits) {
            this.broadcaster.setPlanCap(planCap(limits.liveHeight));
            this.broadcaster.setRelayCap(planCap(limits.relayHeight));
        }
        this.changed();
    }

    async learnBattery() {
        try {
            const battery = await this.options.around.battery?.();
            if (!battery || !this.running) return;
            this.battery = battery;
            for (const type of ['levelchange', 'chargingchange']) battery.addEventListener?.(type, () => this.changed());
            this.changed();
        } catch {
            // A browser that doesn't say: the status leaves it out.
        }
    }

    /** A member's command, already opened and judged fresh. A temporary
     * camera takes three (docs/API.md, Temporary cameras): `end`, `keep`
     * and `peek`. */
    command(from, command) {
        if (command.name === 'end') {
            this.end('home');
            return;
        }
        if (command.name === 'keep') {
            // More time: `value` is its new end. Moved or not, it says the
            // end it holds itself to, which is how a member learns the
            // camera heard.
            if (!(command.value !== null && this.moreTime(command.value))) this.sendStatus();
            return;
        }
        if (command.name === 'peek') {
            // About a frame a second for as long as was asked, 35 seconds at
            // most an ask, so nobody but a member can keep the camera sending.
            const now = this.clock.now();
            const until = now + peekSeconds(command) * 1000;
            this.peekUntil = Math.max(this.peekUntil, until);
            this.peekers.set(from, Math.max(this.peekers.get(from) ?? 0, until + PEEK_NAMED_FOR_MS));
            this.sendStill();
            this.changed();
            return;
        }
        // It does nothing for a name it doesn't know (nor for what an app's
        // camera has and a page hasn't: its light, its zoom, its detection),
        // and says how it is, as after any command.
        this.sendStatus();
    }

    /** More time, from a member: the later of what it's told and the end
     * it has, never past the latest end its pass named, whatever it's told.
     * @param {number} endsAt ms @returns {boolean} whether its end moved */
    moreTime(endsAt) {
        if (!Number.isSafeInteger(endsAt)) return false;
        const allowed = Math.min(endsAt, this.pass.latestEndAt);
        if (!(allowed > this.pass.endsAt)) return false;
        this.pass.endsAt = allowed;
        this.door.keep(this.pass, this.seen.kept()).catch(() => {});
        // Its status names its end, so this sends one.
        this.changed();
        return true;
    }

    /** One still for whoever asked, while their asking lasts and the camera can see. */
    async sendStill() {
        const now = this.clock.now();
        if (!this.running || !this.signals || now >= this.peekUntil || now - this.lastStillAt < STILL_AT_MOST_EVERY_MS) return;
        if (this.keeper.kept.noVideo !== null) return;
        this.lastStillAt = now;
        const jpeg = await this.options.monitor.still().catch(() => null);
        if (jpeg && this.running) await this.signals.sendStill(jpeg, now).catch(() => {});
    }

    /** Once a second: its time, its stills, who still takes them, and its status when that's due. */
    look() {
        if (!this.running) return;
        const now = this.clock.now();
        if (now >= this.pass.endsAt) {
            this.end('time');
            return;
        }
        if (now < this.peekUntil) this.sendStill();
        let fewer = false;
        for (const [device, until] of this.peekers) {
            if (until <= now) {
                this.peekers.delete(device);
                fewer = true;
            }
        }
        if (fewer) this.changed();
        else this.sendStatusIfDue();
        if (now - this.lastRelayReport >= RELAY_REPORT_EVERY_MS) this.reportRelay();
    }

    /** Once a minute, the live video this camera relayed through TURN, for
     * the home's relay hours, as an app's camera reports it; what doesn't
     * reach the Worker goes with the next report. */
    async reportRelay() {
        this.lastRelayReport = this.clock.now();
        this.unreportedRelay += this.broadcaster.takeRelayedSeconds();
        const seconds = Math.round(Math.min(this.unreportedRelay, RELAY_REPORT_MAX_SECONDS));
        if (seconds < 1) return;
        this.unreportedRelay -= seconds;
        try {
            const told = await this.door.relayed(this.pass, seconds);
            // The report that used the month's hours up ends what's relayed; direct connections carry on.
            if (told && this.running) this.broadcaster.setRelayAllowed(told.relay);
        } catch {
            this.unreportedRelay += seconds;
        }
    }

    // ---- Status ------------------------------------------------------------

    status() {
        const using = this.source.using();
        return cameraStatus({
            viewers: this.watching().length,
            noVideo: this.keeper.kept.noVideo,
            cameraPosition: using.camera?.position ?? null,
            battery: this.battery ? this.battery.level : null,
            charging: this.battery ? this.battery.charging : null,
            appVersion: this.options.appVersion,
            endsAt: this.pass.endsAt,
        });
    }

    /** A status goes at once when anything a viewer shows changes, first
     * thing on each new socket, and otherwise every five minutes. */
    sendStatusIfDue() {
        if (!this.running || !this.link?.isOpen) return;
        const shown = shownStatus(this.status());
        const last = this.lastStatus;
        if (last && last.socket === this.link.opened && last.shown === shown && this.clock.now() - last.at < STATUS_REFRESH_MS) return;
        this.sendStatus();
    }

    sendStatus() {
        if (!this.running || !this.signals || !this.link?.isOpen) return;
        const status = this.status();
        this.lastStatus = { shown: shownStatus(status), socket: this.link.opened, at: this.clock.now() };
        this.signals.sendStatus(status).catch(() => {});
    }

    // ---- What its screen shows ---------------------------------------------

    /** One entry a device that's watching or taking stills: its name, or null where its call didn't say. */
    watching() {
        const names = new Map();
        for (const watcher of this.broadcaster.watchers()) names.set(watcher.viewer, names.get(watcher.viewer) ?? watcher.name);
        for (const device of this.peekers.keys()) if (!names.has(device)) names.set(device, null);
        return [...names.values()];
    }

    /** @returns {CameraView} */
    view() {
        const kept = this.keeper.kept;
        /** @type {CameraView['stopping']} */
        const stopping = [];
        if (this.running) {
            if (this.clockOff) stopping.push('clock');
            if (kept.blocked) stopping.push(kept.blocked);
            else if (kept.noVideo === 'stalled') stopping.push('stalled');
            if (this.link && !this.link.isOpen) stopping.push('offline');
            // Last: nothing on this device puts it right.
            if (this.limits === null) stopping.push('plan');
        }
        return {
            startedBy: cleanName(this.pass.startedBy),
            endsAt: this.pass.endsAt,
            // A hidden page isn't read by anyone: what a viewer is told then is in the status.
            live: this.running && stopping.length === 0,
            stopping,
            silent: this.running && kept.silent,
            watching: this.watching(),
            using: this.source.using(),
            charging: this.battery ? this.battery.charging : null,
            ended: this.ended,
        };
    }

    changed() {
        this.sendStatusIfDue();
        const view = this.view();
        const text = JSON.stringify(view);
        if (text === this.lastView) return;
        this.lastView = text;
        this.onView(view);
    }

    /** A person tapped to start the camera again after it was refused. */
    tryAgain() {
        return this.keeper.tryAgain();
    }

    // ---- The end -----------------------------------------------------------

    /** Stop, on its own screen. */
    stop() {
        return this.end('here');
    }

    /**
     * It's over: the camera and the microphone are let go of, every viewer
     * is told, and (unless this same camera runs on in another tab) its
     * device on the Worker and everything the browser kept are deleted.
     * @param {'time' | 'home' | 'here' | 'gone' | 'elsewhere'} why
     * @param {{ deviceGone?: boolean }} [how] `deviceGone`: the Worker already has no such device, so there is nothing to report to it
     */
    async end(why, how = {}) {
        if (this.ended) return;
        this.ended = { why };
        const wasRunning = this.running;
        this.running = false;
        if (this.statusTimer !== null) this.clock.clearInterval(this.statusTimer);
        this.statusTimer = null;
        this.broadcaster.endAll(BYE.cameraStopped);
        this.stopListening?.();
        if (wasRunning) this.keeper.stop();
        this.source.stop();
        // Its goodbyes are sealed and on their way before the socket goes.
        await this.signals?.flushed();
        this.link?.stop?.();
        // What it relayed since its last report is still the home's to
        // count, where there's still a device to report as. Its end doesn't
        // wait on a Worker that can't be reached.
        if (wasRunning && why !== 'elsewhere' && why !== 'gone' && !how.deviceGone) {
            await Promise.race([this.reportRelay().catch(() => {}), new Promise((resolve) => this.clock.setTimeout(() => resolve(undefined), LAST_REPORT_WAITS_MS))]);
        }
        if (why !== 'elsewhere') await this.door.leave().catch(() => {});
        this.lastView = '';
        this.onView(this.view());
    }
}
