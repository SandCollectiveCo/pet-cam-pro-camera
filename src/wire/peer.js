// Messages on the data channel `petcam`, straight between a camera and a
// viewer inside their call's own encryption: the Worker never sees one
// (docs/API.md, Peer data channel).
//
//   camera → viewer   camera_stats, every two seconds while it plays
//   viewer → camera   cap, listen, play, pause, video

import { Refused, object, optional, reader, required } from './read.js';

/** The caps a viewer may ask for, as the apps know them. One nobody here
 * knows fails the whole message, so the camera keeps the cap it had. */
export const QUALITIES = Object.freeze(['auto', 'high', 'medium', 'low', 'tile', 'tile_small']);

/**
 * @typedef {object} PeerMessage
 * @property {string} type
 * @property {string | null} quality one of `QUALITIES`
 * @property {boolean | null} on
 * @property {{ step: string } & Record<string, unknown> | null} stats
 */

/** A message as the apps read one, or null for one they'd refuse. A type
 * nobody knows still reads: nothing acts on it.
 * @type {(json: unknown) => PeerMessage | null} */
export const readPeerMessage = reader((json) => {
    const from = object(json, 'a message');
    const type = required(from, 'type', 'string');
    // `quality` is read strictly whatever the type.
    const quality = optional(from, 'quality', 'string');
    if (quality !== null && !QUALITIES.includes(quality)) throw new Refused(`a cap nobody here knows: ${quality}`);
    return { type, quality, on: optional(from, 'on', 'bool'), stats: from.stats === undefined || from.stats === null ? null : readStats(from.stats) };
});

/** @param {unknown} json */
function readStats(json) {
    const from = object(json, 'stats');
    return {
        step: required(from, 'step', 'string'),
        width: optional(from, 'width', 'int'),
        height: optional(from, 'height', 'int'),
        fps: optional(from, 'fps', 'number'),
        target_kbps: optional(from, 'target_kbps', 'int'),
        bandwidth_kbps: optional(from, 'bandwidth_kbps', 'int'),
        encode_ms: optional(from, 'encode_ms', 'number'),
        send_queue_ms: optional(from, 'send_queue_ms', 'number'),
        limitation: optional(from, 'limitation', 'string'),
        thermal: optional(from, 'thermal', 'string'),
        encoder: optional(from, 'encoder', 'string'),
        mic_percent: optional(from, 'mic_percent', 'number'),
    };
}

/**
 * What the camera tells a viewer about its side of the link. Every field but
 * `step` is left out when the camera doesn't know it.
 * @param {{ step: string, width?: number | null, height?: number | null, fps?: number | null, targetKbps?: number | null, bandwidthKbps?: number | null, encodeMs?: number | null, sendQueueMs?: number | null, limitation?: string | null, encoder?: string | null, micPercent?: number | null }} link
 */
export function cameraStats(link) {
    const stats = { step: link.step };
    const put = (key, value, whole) => {
        if (typeof value === 'number' && Number.isFinite(value)) stats[key] = whole ? Math.round(value) : value;
    };
    put('width', link.width, true);
    put('height', link.height, true);
    put('fps', link.fps, false);
    put('target_kbps', link.targetKbps, true);
    put('bandwidth_kbps', link.bandwidthKbps, true);
    put('encode_ms', link.encodeMs, false);
    put('send_queue_ms', link.sendQueueMs, false);
    if (typeof link.limitation === 'string') stats.limitation = link.limitation;
    if (typeof link.encoder === 'string') stats.encoder = link.encoder;
    put('mic_percent', link.micPercent, false);
    return { type: 'camera_stats', stats };
}
