// Keeping a camera running (docs/WEB-CAMERA.md § 4, Starting again by
// itself). The page watches its tracks (`mute`, `unmute`, `ended`), whether
// it shows (`visibilitychange`), and whether frames still arrive. It holds
// the screen awake while it shows, takes that hold again on return (the
// browser drops it when the page is hidden), and asks for the camera again
// when the picture stopped for no reason the browser gave.
//
// What it can't come back from is the browser or the device restarting, or
// a person saying no: then it says so and waits for a tap.
//
// There is no service worker here, on purpose: a camera runs the code it
// loaded until a person reloads it (§ 2).

import { NO_VIDEO } from '../wire/status.js';

/** How long a visible camera may show no new frame before it counts as stopped. */
export const STALL_MS = 5_000;
/** How long a muted or stopped picture is given to come back by itself
 * before the camera is asked for again. */
export const GRACE_MS = 3_000;
/** The longest the keeper waits between asking again while the picture stays away. */
export const RESTART_AT_MOST_EVERY_MS = 60_000;
const LOOK_EVERY_MS = 1_000;

/**
 * What a keeper needs of the page around it: the browser's, or a test's.
 * @typedef {object} Around
 * @property {{ visibilityState: string, addEventListener: (type: string, listener: () => void) => void, removeEventListener: (type: string, listener: () => void) => void }} doc
 * @property {{ request: (type: 'screen') => Promise<any> } | null | undefined} wakeLock `navigator.wakeLock`, where there is one
 * @property {() => number} now ms
 * @property {(fn: () => void, ms: number) => unknown} setInterval
 * @property {(id: any) => void} clearInterval
 */

/**
 * What a keeper says of the camera, for its status and its screen.
 * @typedef {object} Kept
 * @property {boolean} visible the page shows
 * @property {string | null} noVideo why it can't see: `background` (the page is hidden and the browser took the camera), `stalled`, or null
 * @property {'denied' | 'missing' | 'failed' | null} blocked asking for the camera again was refused, and it waits for a tap
 * @property {'held' | 'released' | 'refused' | 'unsupported'} awake the hold that keeps the screen on
 * @property {boolean} silent the microphone's track has stopped
 */

export class Keeper {
    /**
     * @param {import('./source.js').DeviceSource} source
     * @param {{ count: number, show: (track: MediaStreamTrack | null) => void, play: () => void }} monitor counts the frames that arrive
     * @param {Around} around
     * @param {(kept: Kept) => void} onChange
     */
    constructor(source, monitor, around, onChange) {
        this.source = source;
        this.monitor = monitor;
        this.around = around;
        this.onChange = onChange;
        /** @type {Kept} */
        this.kept = { visible: around.doc.visibilityState === 'visible', noVideo: null, blocked: null, awake: around.wakeLock ? 'released' : 'unsupported', silent: false };
        this.lock = null;
        this.timer = null;
        this.lastCount = 0;
        this.lastFrameAt = 0;
        /** Since when the picture has been away while the page shows; null while it's fine. */
        this.awaySince = null;
        this.nextRestartAt = 0;
        this.restartEvery = GRACE_MS;
        this.restarting = false;
        this.locking = false;
        /** A track was asked for again while the picture was away: it's away until a frame of the new one arrives. */
        this.waitingForFrame = false;
        this.audioAwaySince = null;
        /** Asking for the microphone again didn't help: it's left be until something changes. */
        this.audioGaveUp = false;
        this.onVisibility = () => this.visibilityChanged();
        this.stopListening = null;
        this.watched = new Map();
    }

    start() {
        const now = this.around.now();
        this.lastFrameAt = now;
        this.lastCount = this.monitor.count;
        this.around.doc.addEventListener('visibilitychange', this.onVisibility);
        this.stopListening = this.source.listen((what) => {
            if (what === 'tracks') this.tracksChanged();
        });
        this.tracksChanged();
        this.timer = this.around.setInterval(() => this.look(), LOOK_EVERY_MS);
        this.stayAwake();
    }

    stop() {
        this.around.doc.removeEventListener('visibilitychange', this.onVisibility);
        this.stopListening?.();
        if (this.timer !== null) this.around.clearInterval(this.timer);
        this.timer = null;
        for (const [track, listener] of this.watched) for (const type of ['mute', 'unmute', 'ended']) track.removeEventListener(type, listener);
        this.watched.clear();
        const lock = this.lock;
        this.lock = null;
        lock?.release?.().catch(() => {});
        this.monitor.show(null);
    }

    /** @param {Partial<Kept>} change */
    set(change) {
        const before = JSON.stringify(this.kept);
        this.kept = { ...this.kept, ...change };
        if (JSON.stringify(this.kept) !== before) this.onChange(this.kept);
    }

    // ---- Staying awake ----------------------------------------------------

    /** Holds the screen awake, where the browser can and the page shows. */
    async stayAwake() {
        const wakeLock = this.around.wakeLock;
        if (!wakeLock || this.lock || this.locking || this.timer === null || this.around.doc.visibilityState !== 'visible') return;
        this.locking = true;
        try {
            const lock = await wakeLock.request('screen');
            if (this.timer === null) {
                lock.release?.().catch(() => {});
                return;
            }
            this.lock = lock;
            lock.addEventListener?.('release', () => {
                if (this.lock !== lock) return;
                this.lock = null;
                this.set({ awake: 'released' });
            });
            this.set({ awake: 'held' });
        } catch {
            // A hidden page, a battery saver, or no permission: tried again on the next look.
            this.set({ awake: 'refused' });
        } finally {
            this.locking = false;
        }
    }

    // ---- Tracks -----------------------------------------------------------

    tracksChanged() {
        const current = [this.source.video, this.source.audio].filter(Boolean);
        for (const [track, listener] of this.watched) {
            if (current.includes(track)) continue;
            for (const type of ['mute', 'unmute', 'ended']) track.removeEventListener(type, listener);
            this.watched.delete(track);
        }
        for (const track of current) {
            if (this.watched.has(track)) continue;
            const listener = () => this.look();
            for (const type of ['mute', 'unmute', 'ended']) track.addEventListener(type, listener);
            this.watched.set(track, listener);
        }
        this.monitor.show(this.source.video);
        // A new track's frames are counted from now. One asked for because
        // the picture was away hasn't brought it back until a frame comes.
        this.waitingForFrame = this.awaySince !== null;
        this.lastCount = this.monitor.count;
        this.lastFrameAt = this.around.now();
        this.look();
    }

    visibilityChanged() {
        const visible = this.around.doc.visibilityState === 'visible';
        if (visible) {
            // Back in front: the hold is taken again, the picture is given a
            // moment to come back by itself, and a camera that was refused is
            // worth another try.
            this.monitor.play();
            this.lastFrameAt = this.around.now();
            this.lastCount = this.monitor.count;
            this.awaySince = null;
            this.waitingForFrame = false;
            this.restartEvery = GRACE_MS;
            this.nextRestartAt = 0;
        }
        this.set({ visible });
        if (visible) this.stayAwake();
        this.look();
    }

    /** One look at how things are. */
    look() {
        if (this.timer === null) return;
        const now = this.around.now();
        const visible = this.around.doc.visibilityState === 'visible';
        const video = this.source.video;
        const audio = this.source.audio;
        if (this.monitor.count !== this.lastCount) {
            // A frame came: whatever was tried, it worked.
            this.lastCount = this.monitor.count;
            this.lastFrameAt = now;
            this.waitingForFrame = false;
            this.restartEvery = GRACE_MS;
        }
        const gone = !video || video.readyState === 'ended';
        const muted = !gone && video.muted;
        if (!visible) {
            // A hidden page isn't drawn, so frames can't be counted: the
            // track says whether the browser took the camera (a phone does,
            // a computer mostly doesn't).
            this.awaySince = null;
            this.set({ visible, noVideo: gone || muted ? NO_VIDEO.background : null });
            return;
        }
        const stopped = this.waitingForFrame || now - this.lastFrameAt > STALL_MS;
        const away = gone || muted || stopped;
        if (!away) {
            this.awaySince = null;
            this.set({ visible, noVideo: null, blocked: null });
        } else {
            this.awaySince ??= now;
            // Gone or muted shows at once; a picture that merely paused has had its five seconds.
            this.set({ visible, noVideo: NO_VIDEO.stalled });
            if (!this.kept.blocked && now - this.awaySince >= GRACE_MS && now >= this.nextRestartAt) this.restart('video');
        }
        const audioGone = !audio || audio.readyState === 'ended';
        if (audioGone) {
            this.audioAwaySince ??= now;
            if (!this.kept.blocked && !this.audioGaveUp && now - this.audioAwaySince >= GRACE_MS && now >= this.nextRestartAt) this.restart('audio');
        } else {
            this.audioAwaySince = null;
            this.audioGaveUp = false;
        }
        this.set({ silent: audioGone });
        if (!this.lock && this.kept.awake !== 'unsupported') this.stayAwake();
    }

    /** Asks for the camera, or the microphone, again. Each time it doesn't
     * help, the next try waits twice as long, a minute at most.
     * @param {'video' | 'audio'} which */
    async restart(which) {
        if (this.restarting) return;
        this.restarting = true;
        this.nextRestartAt = this.around.now() + this.restartEvery;
        this.restartEvery = Math.min(this.restartEvery * 2, RESTART_AT_MOST_EVERY_MS);
        try {
            await this.source.restart(which);
        } catch (error) {
            // A microphone that can't be had leaves a camera without sound,
            // which its screen says; it's asked for again when the devices
            // change, or at a tap.
            if (which === 'audio') {
                this.audioGaveUp = true;
                return;
            }
            // The person said no, or took the permission back: asking again
            // would only ask them again. It waits for a tap (`tryAgain`).
            const name = error?.name;
            this.set({ blocked: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing' : 'failed' });
        } finally {
            this.restarting = false;
        }
    }

    /** A person tapped to start the camera again after it was refused. */
    async tryAgain() {
        this.set({ blocked: null });
        this.audioGaveUp = false;
        this.restartEvery = GRACE_MS;
        this.nextRestartAt = 0;
        const gone = (track) => !track || track.readyState === 'ended';
        if (gone(this.source.video) || this.source.video.muted || this.kept.noVideo) await this.restart('video');
        if (gone(this.source.audio)) await this.restart('audio');
        this.look();
    }
}
