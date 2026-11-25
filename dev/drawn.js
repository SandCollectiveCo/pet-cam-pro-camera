// A stand-in for `navigator.mediaDevices` whose camera is a drawn picture
// and whose microphone is a made tone. It's what every page in dev/ and
// every test hands the capture code, in place of the browser's own: no
// camera or microphone is opened, on any computer these run on.
//
// The devices it lists have made-up names, so the page's own screen and its
// choice of microphone can be tried: tracks carry the name of the device
// they were asked from, as a browser's do.

const SIZE = Object.freeze({ width: 1280, height: 720 });

/** The made tone's pitch, so the far end of a test can tell it's the tone that arrived. */
export const TONE_HZ = 660;

export class DrawnDevices extends EventTarget {
    /**
     * @param {Document} doc
     * @param {{ kind: 'videoinput' | 'audioinput', deviceId: string, label: string, facing?: string }[]} devices
     * @param {{ defaultMicrophone?: string }} [defaults]
     */
    constructor(doc, devices, defaults = {}) {
        super();
        this.doc = doc;
        this.list = [...devices];
        this.defaults = defaults;
        this.canvas = null;
        this.drawing = null;
        this.audio = null;
        /** How loud the tone is made: quiet. Quieter still where something will play it aloud (the app in a Simulator, on a Mac's speakers). */
        this.toneGain = 0.15;
        /** How many times a camera or microphone was asked for. */
        this.asks = 0;
        /** Every track handed out and not yet stopped by the page. @type {MediaStreamTrack[]} */
        this.tracks = [];
        this.frame = 0;
    }

    async enumerateDevices() {
        return this.list.map(({ kind, deviceId, label }) => ({ kind, deviceId, label }));
    }

    /** The picture: a colour that turns, a square that moves, a count and a clock. */
    picture() {
        if (this.canvas) return this.canvas;
        const canvas = this.doc.createElement('canvas');
        canvas.width = SIZE.width;
        canvas.height = SIZE.height;
        const context = canvas.getContext('2d');
        const draw = () => {
            const n = ++this.frame;
            context.fillStyle = `hsl(${n % 360} 55% 28%)`;
            context.fillRect(0, 0, SIZE.width, SIZE.height);
            context.fillStyle = '#fff';
            context.fillRect((n * 7) % (SIZE.width - 100), (n * 3) % (SIZE.height - 100), 100, 100);
            context.font = '64px monospace';
            context.fillText(`a drawn picture ${n}`, 40, 90);
            context.fillText(new Date().toISOString().slice(11, 23), 40, 170);
        };
        draw();
        this.drawing = setInterval(draw, 33);
        this.canvas = canvas;
        this.stream = canvas.captureStream(30);
        return canvas;
    }

    /** The tone: quiet, steady, and connected to nothing that plays. */
    tone() {
        if (this.audio) return this.audio;
        const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        const context = new Context();
        const oscillator = context.createOscillator();
        oscillator.frequency.value = TONE_HZ;
        const gain = context.createGain();
        gain.gain.value = this.toneGain;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        // Without a tap a browser may keep it suspended: the track is there, and silent.
        context.resume?.().catch(() => {});
        this.audio = { context, destination };
        return this.audio;
    }

    /** @param {'videoinput' | 'audioinput'} kind @param {any} wanted */
    pick(kind, wanted) {
        const all = this.list.filter((d) => d.kind === kind);
        const exact = wanted?.deviceId?.exact;
        if (exact !== undefined) {
            const found = all.find((d) => d.deviceId === exact);
            if (!found) throw new DOMException('no such device', 'OverconstrainedError');
            return found;
        }
        const facing = wanted?.facingMode?.ideal;
        const found = (kind === 'audioinput' && all.find((d) => d.deviceId === this.defaults.defaultMicrophone)) || (facing && all.find((d) => d.facing === facing)) || all[0];
        if (!found) throw new DOMException('no device', 'NotFoundError');
        return found;
    }

    /** @param {MediaStreamTrack} track @param {{ deviceId: string, label: string, facing?: string }} device */
    named(track, device) {
        const settings = track.getSettings.bind(track);
        Object.defineProperty(track, 'label', { value: device.label, configurable: true });
        Object.defineProperty(track, 'getSettings', { value: () => ({ ...settings(), deviceId: device.deviceId, ...(device.facing ? { facingMode: device.facing } : {}) }), configurable: true });
        this.tracks.push(track);
        return track;
    }

    /** @param {MediaStreamConstraints} constraints */
    async getUserMedia(constraints) {
        this.asks += 1;
        const tracks = [];
        if (constraints.video) {
            const device = this.pick('videoinput', constraints.video);
            this.picture();
            tracks.push(this.named(this.stream.getVideoTracks()[0].clone(), device));
        }
        if (constraints.audio) {
            const device = this.pick('audioinput', constraints.audio);
            tracks.push(this.named(this.tone().destination.stream.getAudioTracks()[0].clone(), device));
        }
        return new MediaStream(tracks);
    }

    /** The drawn picture by itself, as a stream: for a page that only shows it. */
    pictureStream() {
        this.picture();
        return new MediaStream([this.stream.getVideoTracks()[0].clone()]);
    }

    /** The tracks the page still holds open. */
    get open() {
        return this.tracks.filter((track) => track.readyState === 'live');
    }

    /** Whether the made tone is really sounding into its track. */
    get toneRuns() {
        return this.audio?.context.state === 'running';
    }

    /** Stops drawing and sounding, when a page is done with it. */
    close() {
        if (this.drawing !== null) clearInterval(this.drawing);
        this.drawing = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.audio?.context.close().catch(() => {});
    }
}

/** A phone with a camera on each side. */
export const A_DRAWN_PHONE = Object.freeze([
    { kind: 'videoinput', deviceId: 'drawn-back', label: 'Back Camera', facing: 'environment' },
    { kind: 'videoinput', deviceId: 'drawn-front', label: 'Front Camera', facing: 'user' },
    { kind: 'audioinput', deviceId: 'drawn-mic', label: 'Speakerphone' },
]);

/** A Mac with a headset connected, which the system hands a page first. */
export const A_DRAWN_MAC = Object.freeze([
    { kind: 'videoinput', deviceId: 'drawn-mac-camera', label: 'MacBook Pro Camera' },
    { kind: 'audioinput', deviceId: 'drawn-mac-mic', label: 'MacBook Pro Microphone' },
    { kind: 'audioinput', deviceId: 'drawn-airpods', label: 'AirPods' },
]);
