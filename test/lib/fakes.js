// Stand-ins for what a browser gives a page, so the capture code can be run
// through an evening's worth of trouble in a moment and with no device: a
// list of cameras and microphones with made-up names, tracks that mute and
// end when told to, a page that hides, a screen hold the "browser" drops,
// and a clock that only moves when a test moves it.

export class FakeTrack extends EventTarget {
    /** @param {'video' | 'audio'} kind @param {{ deviceId: string, label: string, facing?: string }} device */
    constructor(kind, device) {
        super();
        this.kind = kind;
        this.label = device.label;
        this.deviceId = device.deviceId;
        this.facing = device.facing;
        this.readyState = 'live';
        this.muted = false;
        this.stopped = false;
    }

    getSettings() {
        return this.kind === 'video'
            ? { deviceId: this.deviceId, width: 1280, height: 720, frameRate: 30, ...(this.facing ? { facingMode: this.facing } : {}) }
            : { deviceId: this.deviceId, sampleRate: 48_000 };
    }

    /** The page lets go of it: no event comes, as in a browser. */
    stop() {
        this.stopped = true;
        this.readyState = 'ended';
    }

    /** The browser takes it away for a while. */
    mute() {
        this.muted = true;
        this.dispatchEvent(new Event('mute'));
    }

    unmute() {
        this.muted = false;
        this.dispatchEvent(new Event('unmute'));
    }

    /** It ends by itself: the device went, or the permission did. */
    end() {
        this.readyState = 'ended';
        this.dispatchEvent(new Event('ended'));
    }
}

export class FakeMediaDevices extends EventTarget {
    /**
     * @param {{ kind: 'videoinput' | 'audioinput', deviceId: string, label: string, facing?: string }[]} devices
     * @param {{ defaultMicrophone?: string, defaultCamera?: string }} [defaults] which the system would hand a page that names none
     */
    constructor(devices, defaults = {}) {
        super();
        this.list = [...devices];
        this.defaults = defaults;
        /** Every `getUserMedia` call, as it was asked. */
        this.asked = [];
        /** Every track ever handed out. @type {FakeTrack[]} */
        this.tracks = [];
        /** Set to an error's name to refuse the next asks, as a person or the browser would. @type {string | null} */
        this.refuse = null;
    }

    async enumerateDevices() {
        return this.list.map(({ kind, deviceId, label }) => ({ kind, deviceId, label }));
    }

    /** @param {'videoinput' | 'audioinput'} kind @param {any} wanted */
    pick(kind, wanted) {
        const exact = wanted?.deviceId?.exact;
        const all = this.list.filter((d) => d.kind === kind);
        if (exact !== undefined) {
            const found = all.find((d) => d.deviceId === exact);
            if (!found) throw new DOMException('no such device', 'OverconstrainedError');
            return found;
        }
        const preferred = kind === 'audioinput' ? this.defaults.defaultMicrophone : this.defaults.defaultCamera;
        const facing = wanted?.facingMode?.ideal;
        const found = all.find((d) => d.deviceId === preferred) ?? (facing && all.find((d) => d.facing === facing)) ?? all[0];
        if (!found) throw new DOMException('no device', 'NotFoundError');
        return found;
    }

    async getUserMedia(constraints) {
        this.asked.push(constraints);
        if (this.refuse) throw new DOMException('refused', this.refuse);
        const video = constraints.video ? [new FakeTrack('video', this.pick('videoinput', constraints.video))] : [];
        const audio = constraints.audio ? [new FakeTrack('audio', this.pick('audioinput', constraints.audio))] : [];
        this.tracks.push(...video, ...audio);
        return { getVideoTracks: () => video, getAudioTracks: () => audio };
    }

    /** A device is plugged in or connects. */
    connect(device, how = {}) {
        this.list.push(device);
        if (how.becomesDefault) this.defaults = { ...this.defaults, [device.kind === 'audioinput' ? 'defaultMicrophone' : 'defaultCamera']: device.deviceId };
        this.dispatchEvent(new Event('devicechange'));
    }

    /** A device goes away, and its tracks end. @param {string} deviceId */
    disconnect(deviceId) {
        this.list = this.list.filter((d) => d.deviceId !== deviceId);
        for (const track of this.tracks) if (track.deviceId === deviceId && track.readyState === 'live') track.end();
        this.dispatchEvent(new Event('devicechange'));
    }

    /** The tracks still open: what the device's lights would show. */
    get open() {
        return this.tracks.filter((track) => track.readyState === 'live');
    }
}

/** A clock that moves only when told to, with the timers that hang off it. */
export class FakeClock {
    constructor(start = 1_767_225_600_000) {
        this.time = start;
        this.timers = new Map();
        this.nextId = 1;
        this.now = () => this.time;
        this.setTimeout = (fn, ms) => this.add(fn, ms, null);
        this.setInterval = (fn, ms) => this.add(fn, ms, ms);
        this.clearTimeout = (id) => this.timers.delete(id);
        this.clearInterval = this.clearTimeout;
    }

    add(fn, ms, every) {
        const id = this.nextId++;
        this.timers.set(id, { fn, at: this.time + ms, every });
        return id;
    }

    /** Moves time on, running what comes due in order, and lets the promises
     * each one started settle before the next. @param {number} ms */
    async advance(ms) {
        const end = this.time + ms;
        for (;;) {
            let next = null;
            for (const [id, timer] of this.timers) if (timer.at <= end && (next === null || timer.at < next.timer.at)) next = { id, timer };
            if (!next) break;
            this.time = next.timer.at;
            if (next.timer.every === null) this.timers.delete(next.id);
            else next.timer.at += next.timer.every;
            next.timer.fn();
            await settle();
        }
        this.time = end;
        await settle();
    }
}

/** Lets everything already queued run. */
export async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

export class FakeDoc extends EventTarget {
    constructor() {
        super();
        this.visibilityState = 'visible';
    }

    hide() {
        this.visibilityState = 'hidden';
        this.dispatchEvent(new Event('visibilitychange'));
    }

    show() {
        this.visibilityState = 'visible';
        this.dispatchEvent(new Event('visibilitychange'));
    }
}

export class FakeWakeLock {
    /** @param {FakeDoc} doc */
    constructor(doc) {
        this.doc = doc;
        this.requests = 0;
        /** @type {EventTarget[]} */
        this.held = [];
        // A browser drops the hold when the page is hidden.
        doc.addEventListener('visibilitychange', () => {
            if (doc.visibilityState !== 'visible') this.dropAll();
        });
    }

    async request(type) {
        this.requests += 1;
        if (type !== 'screen' || this.doc.visibilityState !== 'visible') throw new DOMException('the page is hidden', 'NotAllowedError');
        const lock = Object.assign(new EventTarget(), {
            released: false,
            release: async () => {
                if (lock.released) return;
                lock.released = true;
                this.held = this.held.filter((other) => other !== lock);
                lock.dispatchEvent(new Event('release'));
            },
        });
        this.held.push(lock);
        return lock;
    }

    dropAll() {
        for (const lock of [...this.held]) lock.release();
    }
}

/** Counts frames a test says arrived. */
export class FakeMonitor {
    constructor() {
        this.count = 0;
        this.showing = null;
        this.plays = 0;
    }

    show(track) {
        this.showing = track;
    }

    play() {
        this.plays += 1;
    }
}

/** A MacBook with its own camera and microphone, as Safari lists them. */
export const A_MAC = Object.freeze([
    { kind: 'videoinput', deviceId: 'cam-mac', label: 'MacBook Pro Camera' },
    { kind: 'audioinput', deviceId: 'mic-mac', label: 'MacBook Pro Microphone' },
]);
export const AIRPODS = Object.freeze({ kind: 'audioinput', deviceId: 'mic-airpods', label: 'AirPods' });

/** An Android phone, as Chrome lists it: two cameras, and routes for microphones. */
export const AN_ANDROID_PHONE = Object.freeze([
    { kind: 'videoinput', deviceId: 'cam-front', label: 'camera2 1, facing front', facing: 'user' },
    { kind: 'videoinput', deviceId: 'cam-back', label: 'camera2 0, facing back', facing: 'environment' },
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'mic-speaker', label: 'Speakerphone' },
    { kind: 'audioinput', deviceId: 'mic-earpiece', label: 'Headset earpiece' },
]);
