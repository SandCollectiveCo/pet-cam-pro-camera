// Where a camera's picture and sound come from: the one seam between the
// page and a device's camera and microphone (docs/WEB-CAMERA.md § 4).
//
// `DeviceSource` is the real thing. It is handed the browser's
// `navigator.mediaDevices` by whoever starts it and touches no global, so a
// test hands it a stand-in whose camera is a drawn picture and whose
// microphone is a made tone, and the same code runs. Nothing here is tried
// against a real camera until it runs on a device of its owner's.
//
// It asks for 720p at 30 frames a second: a phone's hardware encoder often
// gives up above that, and software encoding is what cooks it. It asks for
// the device's own microphone where it can tell which that is, says which
// camera and microphone it really has (read from the tracks it was given,
// not from what it asked for), and notices when that changes.

import { ownMicrophone, plainName, whoseMicrophone } from './microphone.js';

/** What a camera captures. */
export const CAPTURE = Object.freeze({ width: 1280, height: 720, frameRate: 30 });

/**
 * The parts of `navigator.mediaDevices` a source uses.
 * @typedef {object} MediaDevicesLike
 * @property {(constraints: MediaStreamConstraints) => Promise<MediaStream>} getUserMedia
 * @property {() => Promise<{ deviceId: string, label: string, kind: string }[]>} enumerateDevices
 * @property {(type: 'devicechange', listener: () => void) => void} addEventListener
 * @property {(type: 'devicechange', listener: () => void) => void} removeEventListener
 */

/**
 * What a source has, for the camera's screen and its status.
 * @typedef {object} Using
 * @property {{ name: string, deviceId: string | null, position: 'front' | 'back' | 'external', width: number | null, height: number | null, frameRate: number | null } | null} camera
 * @property {{ name: string, deviceId: string | null, whose: 'own' | 'other' | 'unknown' } | null} microphone
 * @property {{ deviceId: string, name: string }[]} cameras the others it could use
 * @property {{ deviceId: string, name: string }[]} microphones
 * @property {boolean} hasOwnMicrophone whether one of them is the device's own
 */

/** @param {{ ideal?: string } | string | undefined} deviceId */
const videoWanted = (deviceId) => ({
    width: { ideal: CAPTURE.width },
    height: { ideal: CAPTURE.height },
    frameRate: { ideal: CAPTURE.frameRate, max: CAPTURE.frameRate },
    // The camera that faces the room, where a device has two.
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
});

/** The room as it sounds: nothing is done to the sound but the browser's
 * echo canceller, which the plan keeps on for Talk (docs/WEB-CAMERA.md
 * § 4). A pet's noises aren't noise. The first version has no Talk, so
 * nothing plays here for it to cancel: whether asking for it changes how a
 * room sounds on a phone is to be heard on real devices, and it is this one
 * line.
 * @param {string | undefined} deviceId */
const audioWanted = (deviceId) => ({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
});

/** @param {MediaStreamTrack} track */
function positionOf(track) {
    const facing = track.getSettings?.().facingMode;
    return facing === 'environment' ? 'back' : facing === 'user' ? 'front' : 'external';
}

export class DeviceSource {
    /**
     * @param {MediaDevicesLike} mediaDevices the browser's, or a test's stand-in
     * @param {import('../device.js').DeviceKind['kind']} kind what this device is
     */
    constructor(mediaDevices, kind) {
        this.devices = mediaDevices;
        this.kind = kind;
        /** @type {MediaStreamTrack | null} */
        this.video = null;
        /** @type {MediaStreamTrack | null} */
        this.audio = null;
        /** @type {{ deviceId: string, label: string, kind: string }[]} */
        this.listed = [];
        /** The microphone a person picked on the camera's screen, which then stands. @type {string | null} */
        this.pickedMicrophone = null;
        /** @type {Set<(what: 'tracks' | 'using') => void>} */
        this.listeners = new Set();
        this.onDeviceChange = () => {
            this.devicesChanged().catch(() => {});
        };
        this.running = false;
    }

    /** `tracks`: a track was replaced, so whoever sends it has a new one to
     * send; `using`: what's in use, or what could be, changed.
     * @param {(what: 'tracks' | 'using') => void} listener @returns {() => void} */
    listen(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** @param {'tracks' | 'using'} what */
    tell(what) {
        for (const listener of [...this.listeners]) listener(what);
    }

    /** Asks for the camera and the microphone, which is where the browser
     * asks the person. Throws what the browser throws when they say no
     * (`NotAllowedError`) or there is none (`NotFoundError`). */
    async start() {
        let stream;
        try {
            stream = await this.devices.getUserMedia({ video: videoWanted(undefined), audio: audioWanted(undefined) });
        } catch (error) {
            // No microphone to be had isn't no camera: it runs without sound, and its screen says so.
            if (error?.name !== 'NotFoundError' && error?.name !== 'OverconstrainedError') throw error;
            stream = await this.devices.getUserMedia({ video: videoWanted(undefined) });
        }
        this.running = true;
        this.video = stream.getVideoTracks()[0] ?? null;
        this.audio = stream.getAudioTracks()[0] ?? null;
        this.devices.addEventListener('devicechange', this.onDeviceChange);
        // Names are only listed once the person has said yes.
        await this.list();
        await this.preferOwnMicrophone();
        this.tell('tracks');
        this.tell('using');
    }

    async list() {
        try {
            this.listed = await this.devices.enumerateDevices();
        } catch {
            this.listed = [];
        }
    }

    /** If what the browser handed over isn't the device's own microphone and
     * the device's own is there to ask for, asks for that one. A microphone
     * the person picked themselves is left alone. */
    async preferOwnMicrophone() {
        if (this.pickedMicrophone !== null || !this.audio) return;
        if (whoseMicrophone(this.audio.label, this.kind) === 'own') return;
        const own = ownMicrophone(this.listed, this.kind);
        if (!own || own.deviceId === this.audio.getSettings?.().deviceId) return;
        await this.swap('audio', own.deviceId).catch(() => {});
    }

    /** Asks for one track again, from `deviceId` or from whatever the browser
     * gives, and puts it in the old one's place.
     * @param {'video' | 'audio'} which @param {string} [deviceId] */
    async swap(which, deviceId) {
        const stream = await this.devices.getUserMedia(which === 'video' ? { video: videoWanted(deviceId) } : { audio: audioWanted(deviceId) });
        const fresh = (which === 'video' ? stream.getVideoTracks() : stream.getAudioTracks())[0];
        if (!fresh) throw new DOMException(`no ${which} track came`, 'NotFoundError');
        if (!this.running) {
            fresh.stop();
            return;
        }
        const old = this[which];
        this[which] = fresh;
        old?.stop();
    }

    /** The other camera a person picked on the camera's screen. @param {string} deviceId */
    async useCamera(deviceId) {
        await this.swap('video', deviceId);
        await this.list();
        this.tell('tracks');
        this.tell('using');
    }

    /** The microphone a person picked on the camera's screen. @param {string} deviceId */
    async useMicrophone(deviceId) {
        await this.swap('audio', deviceId);
        this.pickedMicrophone = deviceId;
        await this.list();
        this.tell('tracks');
        this.tell('using');
    }

    /** "Use this Mac's microphone": back to the device's own, where it's known. */
    async useOwnMicrophone() {
        const own = ownMicrophone(this.listed, this.kind);
        if (!own) return false;
        await this.swap('audio', own.deviceId);
        this.pickedMicrophone = null;
        this.tell('tracks');
        this.tell('using');
        return true;
    }

    /** Asks for a track again after it stopped: the same camera, or for
     * sound the device's own microphone (a microphone that went away is a
     * reason to take the device's own, not to go quiet).
     * @param {'video' | 'audio'} which */
    async restart(which) {
        if (!this.running) return;
        await this.list();
        const listed = (deviceId) => typeof deviceId === 'string' && this.listed.some((d) => d.deviceId === deviceId);
        if (which === 'video') {
            const had = this.video?.getSettings?.().deviceId;
            await this.swap('video', listed(had) ? had : undefined);
        } else {
            const wanted = listed(this.pickedMicrophone) ? this.pickedMicrophone : ownMicrophone(this.listed, this.kind)?.deviceId;
            if (!listed(this.pickedMicrophone)) this.pickedMicrophone = null;
            await this.swap('audio', wanted ?? undefined);
            await this.preferOwnMicrophone();
        }
        this.tell('tracks');
        this.tell('using');
    }

    /** A device was plugged in, connected or taken away. A headset that
     * connects mustn't become the camera's microphone without its screen
     * saying so; one that goes away takes its track with it, and the
     * device's own is asked for. */
    async devicesChanged() {
        if (!this.running) return;
        await this.list();
        const stillThere = (track) => {
            const id = track?.getSettings?.().deviceId;
            return !id || this.listed.length === 0 || this.listed.some((d) => d.deviceId === id);
        };
        if (!this.audio || this.audio.readyState === 'ended' || !stillThere(this.audio)) await this.restart('audio').catch(() => {});
        else await this.preferOwnMicrophone();
        if (this.video && (this.video.readyState === 'ended' || !stillThere(this.video))) await this.restart('video').catch(() => {});
        this.tell('tracks');
        this.tell('using');
    }

    /** What's in use, read from the tracks themselves. @returns {Using} */
    using() {
        const video = this.video;
        const audio = this.audio;
        const settings = video?.getSettings?.() ?? {};
        const named = (kind) => this.listed.filter((d) => d.kind === kind && d.label !== '' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ deviceId: d.deviceId, name: plainName(d.label) }));
        return {
            camera: video && {
                name: plainName(video.label), deviceId: settings.deviceId ?? null, position: positionOf(video),
                width: settings.width ?? null, height: settings.height ?? null, frameRate: settings.frameRate ?? null,
            },
            microphone: audio && { name: plainName(audio.label), deviceId: audio.getSettings?.().deviceId ?? null, whose: whoseMicrophone(audio.label, this.kind) },
            cameras: named('videoinput'),
            microphones: named('audioinput'),
            hasOwnMicrophone: ownMicrophone(this.listed, this.kind) !== null,
        };
    }

    /** Lets go of the camera and the microphone. */
    stop() {
        this.running = false;
        this.devices.removeEventListener('devicechange', this.onDeviceChange);
        this.video?.stop();
        this.audio?.stop();
        this.video = null;
        this.audio = null;
        this.tell('tracks');
    }
}
