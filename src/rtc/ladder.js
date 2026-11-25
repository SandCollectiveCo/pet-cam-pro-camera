// The steps of live video, and the caps that hold a session to them
// (docs/API.md, Realtime, Quality). They are the apps' own: a viewer names a
// step by these names and caps a session with these words, so the ladder
// here is the whole of theirs even though a page, which captures 720p at 30
// frames a second, never climbs past its fourth step.

/**
 * @typedef {object} Rung
 * @property {string} name what a viewer is told: "720p30"
 * @property {number} height the short side, in pixels
 * @property {number} fps
 * @property {number} minBitrate the encoder target this size needs to look clean, bits a second
 */

/** Ordered by the bitrate each needs. @type {readonly Rung[]} */
export const LADDER = Object.freeze([
    { name: '360p15', height: 360, fps: 15, minBitrate: 0 },
    { name: '360p30', height: 360, fps: 30, minBitrate: 300_000 },
    { name: '540p30', height: 540, fps: 30, minBitrate: 700_000 },
    { name: '720p30', height: 720, fps: 30, minBitrate: 1_200_000 },
    { name: '720p60', height: 720, fps: 60, minBitrate: 1_800_000 },
    { name: '1080p30', height: 1080, fps: 30, minBitrate: 2_500_000 },
    { name: '1080p60', height: 1080, fps: 60, minBitrate: 3_500_000 },
]);

/** Pixels a second the encoder has to handle at a step. @param {Rung} rung */
export const pixelRate = (rung) => Math.floor((rung.height * rung.height * 16) / 9) * rung.fps;

/** What each cap allows: the highest step, and the encoder's ceiling in bits
 * a second (how much of it a link gets is congestion control's call). */
export const CAPS = Object.freeze({
    auto: { top: 6, maxBitrate: 5_000_000 },
    high: { top: 6, maxBitrate: 5_000_000 },
    medium: { top: 4, maxBitrate: 2_500_000 },
    tile: { top: 2, maxBitrate: 1_000_000 },
    tile_small: { top: 1, maxBitrate: 600_000 },
    low: { top: 0, maxBitrate: 450_000 },
});

/** A page's own cap, for every viewer: 720p, as it captures. */
export const CAMERA_CAP = 'medium';

/** Whether a cap is a grid tile's: a session that shows a tile, not a live view. @param {string} cap */
export const isTile = (cap) => cap === 'tile' || cap === 'tile_small';

/** The cap for the tallest picture a home's plan allows (`limits.live_height`):
 * 1080 leaves the ladder open, 720 stops it at 720p, 540 at 540p30.
 * @param {number} height */
export function planCap(height) {
    if (height >= 1080) return 'auto';
    if (height >= 720) return 'medium';
    if (height >= 540) return 'tile';
    return 'tile_small';
}

/** The highest step several caps leave. @param {string[]} caps */
export const topOf = (caps) => Math.min(...caps.map((cap) => CAPS[cap].top));

/** The lowest ceiling several caps leave, in bits a second. @param {string[]} caps */
export const ceilingOf = (caps) => Math.min(...caps.map((cap) => CAPS[cap].maxBitrate));

/** The highest step at or under `ceiling` that `bitrate` pays for with
 * `headroom` to spare, at a frame rate the camera captures.
 * @param {number} bitrate @param {number} headroom @param {number} ceiling @param {number} maxFps */
export function highestStep(bitrate, headroom, ceiling, maxFps) {
    for (let step = Math.min(ceiling, LADDER.length - 1); step >= 0; step--) {
        if (LADDER[step].fps <= maxFps && LADDER[step].minBitrate * headroom <= bitrate) return step;
    }
    return 0;
}

/** The highest step under `from` whose frame rate the camera captures.
 * @param {number} from @param {number} maxFps */
export function stepWithin(from, maxFps) {
    for (let step = Math.min(from, LADDER.length - 1); step >= 0; step--) if (LADDER[step].fps <= maxFps) return step;
    return 0;
}
