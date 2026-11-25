// Picks one viewer's step of the ladder every couple of seconds, from the
// camera's own report for that viewer: the apps' StreamTuner
// (PetCam/Realtime/StreamTuner.swift), step for step. The encoder's target
// bitrate (the link estimate, capped) decides how big a picture fits. A
// send queue over 60 ms or loss over 5% steps it down at once; stepping up
// waits for two readings in a row with a quarter to spare, so it doesn't
// flap.
//
// One thing differs, because of what a browser tells. An app's camera knows
// how hot its device is; a page doesn't. And a browser's word for what
// limits the encoder isn't to be taken alone: on 2026-11-19 Safari said
// "bandwidth" every minute while the picture went out whole, inside one
// page with no network to be short of (docs/WEB-CAMERA.md § 4). So the page
// goes by what was sent, its size and its frames a second, and uses the
// label only to say why: the processor counts as the limit when the browser
// says so and the picture really is short of its step.

import { LADDER, highestStep, pixelRate, stepWithin } from './ladder.js';

/** A send queue past this, in ms, means packets are piling up. */
const QUEUE_LIMIT_MS = 60;
/** Loss past this fraction means the link can't carry the step. */
const LOSS_LIMIT = 0.05;
/** How far under its step's frame rate a picture has to be to count as short. */
const SHORT_OF_FPS = 0.8;

export class StreamTuner {
    /** @param {number} top the highest step this viewer and the camera allow */
    constructor(top) {
        this.limit = top;
        // Start mid-ladder: the link estimate ramps up within seconds.
        this.rung = Math.min(top, 2);
        this.goodReadings = 0;
        this.processorReadings = 0;
        this.previous = null;
        this.microphoneStart = null;
    }

    get top() {
        return this.limit;
    }

    set top(top) {
        this.limit = top;
        this.rung = Math.min(this.rung, top);
    }

    /**
     * Reads one report and moves the step. Returns what the viewer is told
     * about the camera's side of the link.
     * @param {import('./stats.js').Reading} reading
     * @param {{ at: number, maxFps: number }} now `at` in seconds, from a clock that only goes forward; `maxFps` the rate the camera captures at
     */
    update(reading, now) {
        const video = reading.video;
        const target = video?.targetBitrate ?? null;
        const bandwidth = reading.path?.availableOutgoingBitrate ?? null;
        const loss = reading.fractionLost ?? 0;
        const limitation = video?.limitation ?? null;

        const sample = {
            at: now.at,
            framesEncoded: video?.framesEncoded ?? 0,
            encodeTime: video?.totalEncodeTime ?? 0,
            packetsSent: video?.packetsSent ?? 0,
            sendDelay: video?.totalPacketSendDelay ?? null,
            microphoneSeconds: reading.microphoneSeconds ?? 0,
        };
        let encodeMs = null;
        let sendQueueMs = null;
        let sentFps = video?.framesPerSecond ?? null;
        if (this.previous) {
            const frames = sample.framesEncoded - this.previous.framesEncoded;
            if (frames > 0) encodeMs = ((sample.encodeTime - this.previous.encodeTime) / frames) * 1000;
            const packets = sample.packetsSent - this.previous.packetsSent;
            if (packets > 0 && sample.sendDelay !== null && this.previous.sendDelay !== null) sendQueueMs = ((sample.sendDelay - this.previous.sendDelay) / packets) * 1000;
            // Where the browser gives no rate, the frames it counted do.
            const seconds = sample.at - this.previous.at;
            if (sentFps === null && seconds > 0 && frames >= 0) sentFps = frames / seconds;
        }
        this.previous = sample;
        // Seconds of microphone sound the connection got per second since the
        // call began: under 100 means capture drops sound.
        let micPercent = null;
        if (this.microphoneStart) {
            const elapsed = sample.at - this.microphoneStart.at;
            if (elapsed > 0) micPercent = ((sample.microphoneSeconds - this.microphoneStart.seconds) / elapsed) * 100;
        } else if (sample.microphoneSeconds > 0) {
            this.microphoneStart = { at: sample.at, seconds: sample.microphoneSeconds };
        }

        let ceiling = this.limit;
        // The browser's word, held against what was sent.
        const current = LADDER[this.rung];
        const short = (sentFps !== null && sentFps < current.fps * SHORT_OF_FPS) || (video?.frameHeight != null && video.frameWidth != null && Math.min(video.frameHeight, video.frameWidth) < current.height * 0.9);
        this.processorReadings = limitation === 'cpu' && short ? this.processorReadings + 1 : 0;
        if (this.processorReadings >= 2) {
            // The next step down by bitrate isn't always less work, so drop by pixels a second.
            const budget = Math.floor((pixelRate(current) * 7) / 10);
            let fitting = 0;
            for (let step = LADDER.length - 1; step >= 0; step--) {
                if (pixelRate(LADDER[step]) <= budget) {
                    fitting = step;
                    break;
                }
            }
            ceiling = Math.min(ceiling, fitting);
            this.processorReadings = 0;
        }
        // A 60 fps step while capture runs at 30 would send 30 anyway.
        if (LADDER[this.rung].fps > now.maxFps) this.rung = stepWithin(this.rung - 1, now.maxFps);

        const available = target ?? bandwidth ?? 0;
        const fits = highestStep(available, 1, ceiling, now.maxFps);
        const fitsWithRoom = highestStep(available, 1.25, ceiling, now.maxFps);
        if ((sendQueueMs ?? 0) > QUEUE_LIMIT_MS || loss > LOSS_LIMIT) {
            // Packets are piling up or getting lost: latency first.
            this.rung = Math.max(Math.min(this.rung, fits) - 1, 0);
            this.goodReadings = 0;
        } else if (fits < this.rung) {
            this.rung = fits;
            this.goodReadings = 0;
        } else if (fitsWithRoom > this.rung) {
            this.goodReadings += 1;
            if (this.goodReadings >= 2) {
                this.rung = fitsWithRoom;
                this.goodReadings = 0;
            }
        } else {
            this.goodReadings = 0;
        }
        this.rung = Math.min(this.rung, ceiling);

        return {
            step: LADDER[this.rung].name,
            width: video?.frameWidth ?? null,
            height: video?.frameHeight ?? null,
            fps: sentFps,
            targetKbps: target === null ? null : Math.floor(target / 1000),
            bandwidthKbps: bandwidth === null ? null : Math.floor(bandwidth / 1000),
            encodeMs,
            sendQueueMs,
            limitation,
            encoder: video?.encoder ?? null,
            micPercent,
        };
    }
}
