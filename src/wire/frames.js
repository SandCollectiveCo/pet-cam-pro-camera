// The realtime socket's own frames, around what the devices seal for each
// other (docs/API.md, Realtime; docs/vectors/realtime-v1.json), and the
// answer that lists relay addresses (ICE servers).
//
// A temporary camera's socket carries its own status, signals to and from
// the home's devices, commands sent to it, the stills a member asked for,
// the `error` for a signal of its own and `limits_changed`, and nothing
// else (docs/API.md, Temporary cameras, Its socket). How its socket is
// opened (a browser can't send the Authorization header there, so a one-use
// ticket) is the door's: src/join/. What the Worker says of the camera
// itself (`GET /v1/me`: its plan's caps and the Worker's clock) is read
// here too, for the door to ask.

import { fromB64url } from '../crypto/bytes.js';
import { Refused, isObject, object, optional, reader, required } from './read.js';

/** The heartbeat: neither frame is JSON. A camera in front pings every 15
 * seconds; no answer in 10 means the connection died without closing. The
 * Worker counts a socket gone after 75 seconds without a ping. */
export const HEARTBEAT = Object.freeze({ ping: 'ping', pong: 'pong', everyMs: 15_000, replyWithinMs: 10_000 });

/** Why the Worker closes a socket (docs/API.md): another socket of this
 * device replaced it, it stopped pinging, the device is out of the home (or
 * the home is gone), or it sent too much the server dropped. */
export const CLOSE = Object.freeze({ replaced: 4001, silent: 4002, gone: 4003, dropped: 1008 });

/** The longest sealed text the Worker takes: a signal's payload, and a
 * command's or a status's. */
export const MAX_SEALED = Object.freeze({ signal: 65_536, command: 4_096, status: 4_096 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A device id as the Worker takes one: a lowercase UUID. @param {unknown} id */
export const isDeviceId = (id) => typeof id === 'string' && UUID.test(id);

/** A session id as the Worker takes one. @param {unknown} session */
export const isSession = (session) => typeof session === 'string' && SESSION.test(session);

/** Whether `value` is `{"sealed": "<a sealed message>"}` and nothing else:
 * base64url, a version byte the apps seal messages with, long enough to
 * hold a header, a nonce and a tag. It says nothing of whether it opens.
 * @param {unknown} value @param {number} [maxChars] */
export function isSealed(value, maxChars = MAX_SEALED.signal) {
    if (!isObject(value) || Object.keys(value).length !== 1) return false;
    const text = value.sealed;
    if (typeof text !== 'string' || text.length > maxChars || !BASE64URL.test(text)) return false;
    const bytes = fromB64url(text);
    return (bytes[0] === 0x04 && bytes.length >= 5 + 12 + 16) || (bytes[0] === 0x02 && bytes.length >= 1 + 12 + 16);
}

/** @param {unknown} value @param {string} what @param {number} maxChars @returns {{ sealed: string }} */
function sealed(value, what, maxChars) {
    if (!isSealed(value, maxChars)) throw new Refused(`${what} isn't sealed`);
    return /** @type {{ sealed: string }} */ (value);
}

/**
 * The two caps the home's plan sets a temporary camera's picture, or null
 * while its home has no plan that allows one: nobody can watch it then, and
 * nothing ends (docs/API.md, Temporary cameras, What the Worker holds it to).
 * @typedef {{ liveHeight: number, relayHeight: number }} Limits
 */

/** `{ "live_height": 720, "relay_height": 720 }`, or null. @param {unknown} value @returns {Limits | null} */
function limitsOf(value) {
    if (value === undefined || value === null) return null;
    const from = object(value, 'limits');
    const limits = { liveHeight: required(from, 'live_height', 'int'), relayHeight: required(from, 'relay_height', 'int') };
    if (limits.liveHeight < 1 || limits.relayHeight < 1) throw new Refused('a cap is a height');
    return limits;
}

/**
 * A text frame from the Worker as the apps read one, or null for one that
 * doesn't read (dropped, as if it never came). What's sealed inside is left
 * sealed. A type nobody here knows reads as its type alone: nothing acts on
 * it.
 * @param {string} text
 * @returns {{ type: 'presence', devices: { id: string, role: string | null, online: boolean, status: { sealed: string } | null }[] }
 *   | { type: 'signal', from: string, session: string, payload: { sealed: string } }
 *   | { type: 'command', from: string, command: { sealed: string } }
 *   | { type: 'error', code: string, to: string | null, session: string | null }
 *   | { type: 'keys_changed', epoch: number }
 *   | { type: 'limits_changed', limits: Limits | null }
 *   | { type: string }
 *   | null}
 */
export function readFrame(text) {
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    return readParsedFrame(json);
}

const readParsedFrame = reader((json) => {
    const from = object(json, 'a frame');
    const type = required(from, 'type', 'string');
    switch (type) {
        case 'presence': {
            if (!Array.isArray(from.devices)) throw new Refused('no devices');
            return {
                type,
                devices: from.devices.map((entry) => {
                    const device = object(entry, 'a device');
                    return {
                        id: required(device, 'id', 'string'),
                        role: optional(device, 'role', 'string'),
                        online: required(device, 'online', 'bool'),
                        status: device.status === undefined || device.status === null ? null : sealed(device.status, 'a status', MAX_SEALED.status),
                    };
                }),
            };
        }
        case 'signal':
            return { type, from: required(from, 'from', 'string'), session: required(from, 'session', 'string'), payload: sealed(from.payload, 'a payload', MAX_SEALED.signal) };
        case 'command':
            return { type, from: required(from, 'from', 'string'), command: sealed(from.command, 'a command', MAX_SEALED.command) };
        case 'error':
            return { type, code: optional(from, 'code', 'string') ?? 'error', to: optional(from, 'to', 'string'), session: optional(from, 'session', 'string') };
        case 'keys_changed':
            return { type, epoch: required(from, 'epoch', 'int') };
        case 'limits_changed':
            // To a temporary camera's own socket: its home's plan ran out (null), is back, or its caps changed.
            return { type, limits: limitsOf(from.limits) };
        default:
            return { type };
    }
});

// ---- A temporary camera's own row: GET /v1/me -----------------------------

/**
 * What the Worker tells a `web` device of itself, as the page reads it, or
 * null for an answer it would refuse: `{ "device": Device, "limits": {…} |
 * null, "now": <ms> }` (docs/API.md, Temporary cameras, Its own routes).
 * Its own row, the caps its home's plan sets its picture, and the Worker's
 * clock as it answered. The page says so when that clock and its own are
 * far apart, and sets nothing by it: not its clock, not its end. `endsAt`
 * is the Worker's copy of its end, which the page doesn't go by either: its
 * end is its pass's.
 * @type {(json: unknown) => { deviceId: string, householdId: string | null, endsAt: number | null, limits: Limits | null, now: number | null } | null}
 */
export const readOwnRow = reader((json) => {
    const from = object(json, 'the answer');
    const device = object(from.device, 'its device');
    const mark = device.temporary === undefined || device.temporary === null ? null : object(device.temporary, 'its mark');
    return {
        deviceId: required(device, 'id', 'string'),
        householdId: optional(device, 'household_id', 'string'),
        endsAt: mark ? optional(mark, 'ends_at', 'int') : null,
        limits: limitsOf(from.limits),
        now: optional(from, 'now', 'int'),
    };
});

// What a camera sends. Each is checked as the Worker checks it, since a frame
// the Worker drops is never answered: better to throw here.

/** @param {string} to a device id @param {string} session @param {{ sealed: string }} payload */
export function signalFrame(to, session, payload) {
    if (!isDeviceId(to)) throw new Refused('a signal goes to one device, by its id');
    if (!isSession(session)) throw new Refused('a session is 1 to 64 of A-Z a-z 0-9 _ -');
    return JSON.stringify({ type: 'signal', to, session, payload: sealed(payload, 'a payload', MAX_SEALED.signal) });
}

/** @param {{ sealed: string }} status */
export function statusFrame(status) {
    return JSON.stringify({ type: 'status', status: sealed(status, 'a status', MAX_SEALED.status) });
}

/** The largest still the Worker keeps, sealed: larger frames are dropped. */
export const MAX_PEEK_BYTES = 256 * 1024;

// ---- Relay addresses: GET /v1/ice-servers --------------------------------

/**
 * The answer as the apps read it, or null for one they'd refuse (and then go
 * on with STUN alone).
 * @type {(json: unknown) => { iceServers: { urls: string[], username: string | null, credential: string | null }[], expiresAt: number, relay: boolean | null } | null}
 */
export const readIceServers = reader((json) => {
    const from = object(json, 'the answer');
    if (!Array.isArray(from.ice_servers)) throw new Refused('no ice_servers');
    return {
        iceServers: from.ice_servers.map((entry) => {
            const server = object(entry, 'a server');
            if (!Array.isArray(server.urls) || !server.urls.every((url) => typeof url === 'string')) throw new Refused('urls is a list of text');
            return { urls: /** @type {string[]} */ (server.urls), username: optional(server, 'username', 'string'), credential: optional(server, 'credential', 'string') };
        }),
        expiresAt: required(from, 'expires_at', 'int'),
        relay: optional(from, 'relay', 'bool'),
    };
});

/** What a call falls back to when the answer can't be had. */
export const STUN_ONLY = Object.freeze([{ urls: ['stun:stun.cloudflare.com:3478'], username: null, credential: null }]);
