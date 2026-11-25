// A still for a grid tile (a peek frame), before it is sealed: when it was
// captured, the JPEG, then zeros to one size, so every frame is the same
// length whatever the picture holds (docs/API.md, Realtime).

import { bigEndian, fromBigEndian } from './bytes.js';

/** Every peek frame is this long before it's sealed. */
export const PEEK_FRAME_SIZE = 32 * 1024;

/** The largest JPEG that fits one: a busier picture is encoded again, smaller. */
export const PEEK_JPEG_MAX = PEEK_FRAME_SIZE - 8;

/** @param {Uint8Array} jpeg */
export const fitsPeekFrame = (jpeg) => jpeg.length > 0 && jpeg.length <= PEEK_JPEG_MAX;

/** When it was captured (ms, u64 big-endian), the JPEG, then zeros to 32,768 bytes.
 * @param {Uint8Array} jpeg @param {number} capturedAtMs @returns {Uint8Array} */
export function packPeekFrame(jpeg, capturedAtMs) {
    const out = new Uint8Array(Math.max(PEEK_FRAME_SIZE, 8 + jpeg.length));
    out.set(bigEndian(Math.max(0, Math.floor(capturedAtMs)), 8), 0);
    out.set(jpeg, 8);
    return out;
}

/** A JPEG ends in FF D9, so the padding is every zero after its last other byte.
 * @param {Uint8Array} frame @returns {{ capturedAtMs: number, jpeg: Uint8Array } | null} */
export function unpackPeekFrame(frame) {
    if (frame.length <= 8) return null;
    let end = frame.length;
    while (end > 8 && frame[end - 1] === 0) end -= 1;
    return { capturedAtMs: fromBigEndian(frame.subarray(0, 8)), jpeg: frame.subarray(8, end) };
}
