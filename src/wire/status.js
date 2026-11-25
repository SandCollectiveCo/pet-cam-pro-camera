// A camera's status: how it is, sealed for the home (docs/API.md, Realtime,
// CameraStatus). A temporary camera says what a page can tell and nothing
// else: how many are watching, which camera faces the room, its release,
// why it can't see where it can't, its battery where the browser tells
// (Chrome does, Safari doesn't), and the end it holds itself to. It has no
// heat to report, no detection, no light, no zoom and no Paused, and leaves
// out what it doesn't know.
//
// The fields and their order are the contract's for a temporary camera
// (docs/API.md, Temporary cameras, Its end, more time, and ending), which
// its vectors pin: test/wire.test.js holds this to the two statuses there.

import { Refused, object, optional, reader } from './read.js';

/** Why a camera can't see right now, as the apps know the reasons. A hidden
 * page is `background`, as a locked iPhone is; frames that stopped for no
 * reason the browser gave are `stalled`. */
export const NO_VIDEO = Object.freeze({ background: 'background', stalled: 'stalled' });

const NO_VIDEO_KNOWN = ['background', 'in_use', 'multitasking', 'pressure', 'stalled', 'closed'];
const ORIENTATIONS = ['auto', 'landscape', 'portrait', 'landscape_upside_down', 'portrait_upside_down'];

/**
 * What a temporary camera says of itself. `sent_at` goes in as it's sealed.
 * @param {{
 *   viewers: number,
 *   noVideo: string | null,
 *   cameraPosition: 'front' | 'back' | 'external' | null,
 *   battery: number | null,
 *   charging: boolean | null,
 *   appVersion: string,
 *   endsAt: number,
 * }} now `appVersion` is "web (<release>)"; `endsAt` the end the camera holds itself to, ms
 */
export function cameraStatus(now) {
    return {
        ...(now.battery !== null ? { battery: Math.round(now.battery * 100) / 100 } : {}),
        ...(now.charging !== null ? { charging: now.charging } : {}),
        viewers: now.viewers,
        ...(now.cameraPosition ? { camera_position: now.cameraPosition } : {}),
        app_version: now.appVersion,
        // Said only while there's a reason: a status with none is a camera that can see.
        ...(now.noVideo !== null ? { no_video: now.noVideo } : {}),
        // A member that reads a sooner end here than its own tells the camera of its more time again.
        ends_at: now.endsAt,
    };
}

/** What a viewer shows of a status: all of it but when it was sent. A camera
 * sends its status when this changes, and otherwise every five minutes.
 * @param {Record<string, unknown>} status */
export function shownStatus(status) {
    const { sent_at: _sentAt, ...shown } = status;
    return JSON.stringify(shown);
}

/** The longest a camera goes without saying how it is. */
export const STATUS_REFRESH_MS = 300_000;

/** A status as the apps read one, or null for one they'd refuse: held to
 * the vectors so that nothing this page sends is one of those. Only what a
 * viewer's types are strict about is checked.
 * @type {(json: unknown) => { noVideo: string | null, orientation: string | null } | null} */
export const readStatus = reader((json) => {
    const from = object(json, 'a status');
    optional(from, 'battery', 'number');
    optional(from, 'charging', 'bool');
    optional(from, 'thermal', 'string');
    optional(from, 'armed', 'bool');
    optional(from, 'night_light', 'bool');
    optional(from, 'viewers', 'int');
    optional(from, 'quality', 'string');
    optional(from, 'sound_level_db', 'number');
    optional(from, 'last_event_at', 'int');
    optional(from, 'camera_position', 'string');
    optional(from, 'zoom', 'number');
    optional(from, 'app_version', 'string');
    optional(from, 'light', 'string');
    optional(from, 'sent_at', 'int');
    optional(from, 'ends_at', 'int');
    if (from.zoom_range !== undefined && from.zoom_range !== null) {
        const range = object(from.zoom_range, 'zoom_range');
        optional(range, 'min', 'number');
        optional(range, 'max', 'number');
        if (range.lenses !== undefined && range.lenses !== null && !(Array.isArray(range.lenses) && range.lenses.every((lens) => typeof lens === 'number'))) throw new Refused('lenses are numbers');
    }
    if (from.detection !== undefined && from.detection !== null) {
        // Inside `detection` every setting is required.
        const detection = object(from.detection, 'detection');
        for (const key of ['motion', 'sounds', 'alarms', 'record_clips', 'upload_clips']) if (typeof detection[key] !== 'boolean') throw new Refused(`detection.${key}`);
        for (const key of ['motion_sensitivity', 'sound_sensitivity']) if (!Number.isInteger(detection[key])) throw new Refused(`detection.${key}`);
        if (typeof detection.cooldown_seconds !== 'number') throw new Refused('detection.cooldown_seconds');
    }
    const noVideo = optional(from, 'no_video', 'string');
    const orientation = optional(from, 'orientation', 'string');
    return {
        // A reason or a way of turning nobody knows reads as the plain one.
        noVideo: noVideo === null ? null : NO_VIDEO_KNOWN.includes(noVideo) ? noVideo : 'stalled',
        orientation: orientation === null ? null : ORIENTATIONS.includes(orientation) ? orientation : 'auto',
    };
});
