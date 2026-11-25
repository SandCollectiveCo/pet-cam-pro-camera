// The camera's own look at its picture: a video element the track plays in.
// It counts the frames that really arrive (a track can be "live" and show
// nothing), is where a still for a grid tile is taken from, and is the
// small picture a person aims the camera by.

import { PEEK_JPEG_MAX, fitsPeekFrame } from '../crypto/peek.js';

/** A still's sizes, tried in turn until one fits a peek frame: the longer
 * side in pixels, and the JPEG quality. The apps' own steps. */
const STILL_TRIES = Object.freeze([[480, 0.5], [480, 0.3], [360, 0.2]]);

export class VideoMonitor {
    /** @param {HTMLVideoElement} video @param {Document} doc */
    constructor(video, doc) {
        this.video = video;
        this.doc = doc;
        /** Frames shown since the page loaded. */
        this.count = 0;
        this.generation = 0;
        this.polling = null;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
    }

    /** @param {MediaStreamTrack | null} track */
    show(track) {
        this.generation += 1;
        if (this.polling !== null) clearInterval(this.polling);
        this.polling = null;
        if (!track) {
            this.video.srcObject = null;
            return;
        }
        this.video.srcObject = new MediaStream([track]);
        this.play();
        const mine = this.generation;
        if (typeof this.video.requestVideoFrameCallback === 'function') {
            const frame = () => {
                if (mine !== this.generation) return;
                this.count += 1;
                this.video.requestVideoFrameCallback(frame);
            };
            this.video.requestVideoFrameCallback(frame);
        } else {
            // An older browser: the video's own clock moves only while frames do.
            let last = -1;
            this.polling = setInterval(() => {
                if (this.video.currentTime === last) return;
                last = this.video.currentTime;
                this.count += 1;
            }, 250);
        }
    }

    play() {
        this.video.play?.()?.catch?.(() => {});
    }

    /** The frame it shows now as a JPEG small enough for a grid tile's still,
     * or null when there's no picture to take or none fits.
     * @returns {Promise<Uint8Array | null>} */
    async still() {
        const { videoWidth: width, videoHeight: height } = this.video;
        if (!width || !height) return null;
        const canvas = this.doc.createElement('canvas');
        for (const [side, quality] of STILL_TRIES) {
            const scale = Math.min(1, side / Math.max(width, height));
            canvas.width = Math.max(2, Math.round(width * scale));
            canvas.height = Math.max(2, Math.round(height * scale));
            const context = canvas.getContext('2d');
            if (!context) return null;
            context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (!blob || blob.size > PEEK_JPEG_MAX) continue;
            const jpeg = new Uint8Array(await blob.arrayBuffer());
            if (fitsPeekFrame(jpeg)) return jpeg;
        }
        return null;
    }
}
