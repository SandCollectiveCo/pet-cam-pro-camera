// A signal's payload: what a viewer and a camera say to each other to set a
// call up, sealed, through the Worker (docs/API.md, Realtime, Signal
// payloads). A viewer sends `watch`; the camera answers with a signed
// `offer`; the viewer sends a signed `answer`; both send `candidate`s; either
// ends it with `bye`.

import { cleanName } from '../names.js';
import { QUALITIES } from './peer.js';
import { object, optional, reader, required } from './read.js';

/** A signal further than this from the receiver's clock is never acted on:
 * a watch the server played back would start a session nobody is there for. */
export const SIGNAL_WINDOW_MS = 120_000;

/** Why a camera ends a session, as viewers read it (docs/API.md). */
export const BYE = Object.freeze({
    badSignature: 'bad_signature',
    cameraStopped: 'camera_stopped',
    relayLimit: 'relay_limit',
    /** A session made without the relay whose path turned out relayed all the same (The Relay switch). */
    relayOff: 'relay_off',
    timeout: 'timeout',
    offerFailed: 'offer_failed',
});

/**
 * @typedef {object} Signal
 * @property {string} kind
 * @property {boolean | null} audio
 * @property {string | null} quality
 * @property {boolean | null} warm
 * @property {string | null} sdp
 * @property {string | null} sig
 * @property {string | null} candidate
 * @property {string | null} sdpMid
 * @property {number | null} sdpMLineIndex
 * @property {string | null} reason
 * @property {number | null} sentAt
 * @property {boolean | null} relay only ever said as false: in a `watch`, that the viewer's Relay switch is off (The Relay switch)
 * @property {string | null} viewerName what the calling device is called, in a `watch` to a temporary camera, held to the rule for names
 */

/** A payload as the apps read one, or null for one they'd refuse. A kind,
 * a cap or a reason nobody knows still reads: they travel as text.
 * @type {(json: unknown) => Signal | null} */
export const readSignal = reader((json) => {
    const from = object(json, 'a signal');
    return {
        kind: required(from, 'kind', 'string'),
        audio: optional(from, 'audio', 'bool'),
        quality: optional(from, 'quality', 'string'),
        warm: optional(from, 'warm', 'bool'),
        sdp: optional(from, 'sdp', 'string'),
        sig: optional(from, 'sig', 'string'),
        candidate: optional(from, 'candidate', 'string'),
        sdpMid: optional(from, 'sdp_mid', 'string'),
        sdpMLineIndex: optional(from, 'sdp_m_line_index', 'int'),
        reason: optional(from, 'reason', 'string'),
        sentAt: optional(from, 'sent_at', 'int'),
        // True or false, or the whole signal is refused: "off" is neither.
        relay: optional(from, 'relay', 'bool'),
        // For the camera's own screen and nothing else. A name that isn't text, or has nothing in it, is no name.
        viewerName: cleanName(from.viewer_name),
    };
});

/** Whether a signal may be acted on at `now`: it says when it was sent, and
 * that's within two minutes of this clock, either way.
 * @param {Signal} signal @param {number} now ms */
export const signalIsFresh = (signal, now) => signal.sentAt !== null && Math.abs(now - signal.sentAt) < SIGNAL_WINDOW_MS;

/** What a `watch` asks for, with what's left unsaid filled in as a camera
 * reads it: no `audio` is true, no `quality` (or one this camera doesn't
 * know) is auto, no `warm` is false, and no `relay` is true (a viewer says
 * it only as false, where its Relay switch is off).
 * @param {Signal} signal @returns {{ audio: boolean, quality: string, warm: boolean, relay: boolean }} */
export const watchTerms = (signal) => ({
    audio: signal.audio ?? true,
    quality: signal.quality !== null && QUALITIES.includes(signal.quality) ? signal.quality : 'auto',
    warm: signal.warm ?? false,
    relay: signal.relay ?? true,
});

// What a camera sends. `sent_at` goes in as each is sealed.

/** An offer. `relay` false says the camera made the session without the
 * relay, which it writes as `"relay": false` and never as true: with the
 * relay it says nothing. It is outside what `sig` covers.
 * @param {string} sdp @param {string} sig over "<session>|offer|<sdp>" @param {boolean} [relay] */
export const offerSignal = (sdp, sig, relay = true) => ({ kind: 'offer', sdp, sig, ...(relay ? {} : { relay: false }) });

/** @param {{ candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }} candidate */
export const candidateSignal = (candidate) => ({
    kind: 'candidate',
    candidate: candidate.candidate,
    ...(candidate.sdpMid !== null && candidate.sdpMid !== undefined ? { sdp_mid: candidate.sdpMid } : {}),
    sdp_m_line_index: candidate.sdpMLineIndex ?? 0,
});

/** @param {string | null} [reason] one of `BYE`, or none */
export const byeSignal = (reason) => (reason ? { kind: 'bye', reason } : { kind: 'bye' });
