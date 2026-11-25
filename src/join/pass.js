// The pass: what the approving device hands a temporary camera in a
// keyring's place (docs/API.md, Temporary cameras, The pass; vectors/
// temporary-camera-v1.json, `pass`). Inside is the camera's own secret, the
// home's epoch as it starts, its times, and the name of whoever started it:
// never a key of the home's.
//
// The page takes one only if, in this order:
//
//   1. the id the Worker gave it is its own key's;
//   2. the approval's MAC holds under its link's token for that id, the
//      listed epoch, the listed sender and the listed pass;
//   3. the pass opens as that sender's (HPKE, auth mode) for the household
//      the Worker says it is in, its own id and that epoch;
//   4. the epoch inside is that one;
//   5. it isn't past its end by the page's own clock.
//
// Then it derives its keys, which can be used and not read, and forgets the
// secret. `takePass` is that order, and nothing else in the page takes one.

import { SealError, fromB64url, textOf } from '../crypto/bytes.js';
import { PASS_INFO, hpkeOpen, passAad } from '../crypto/hpke.js';
import { KeySet, MAX_EPOCH } from '../crypto/keys.js';
import { cameraIdOf } from './id.js';

/** The longest a temporary camera may last from its start, whatever anyone
 * tells it: every device holds one to a week, whoever made its pass. */
export const LONGEST_MS = 7 * 24 * 60 * 60_000;

/** @param {unknown} at */
const isTime = (at) => Number.isSafeInteger(at) && /** @type {number} */ (at) >= 0;

/**
 * A pass's inside, read: snake_case JSON with its secret as base64url.
 * Throws for what a camera refuses: a secret that isn't 32 bytes, an epoch
 * out of range, times no temporary camera has (it ends after it starts, by
 * its latest end, which is a week from its start at most), a name that
 * isn't text. Fields it doesn't know are passed over.
 * @param {string} text
 * @returns {{ secret: Uint8Array, epoch: number, startedAt: number, endsAt: number, latestEnd: number, startedByName: string | null }}
 */
export function readPassInside(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new SealError('malformed', 'not JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SealError('malformed', 'not a pass');
    const name = parsed.started_by_name;
    if (name !== undefined && name !== null && typeof name !== 'string') throw new SealError('malformed', 'a name is text');
    const { epoch, started_at: startedAt, ends_at: endsAt, latest_end: latestEnd } = parsed;
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) throw new SealError('malformed', 'an epoch out of range');
    if (!isTime(startedAt) || !isTime(endsAt) || !isTime(latestEnd)) throw new SealError('malformed', 'a time is whole milliseconds');
    if (!(startedAt < endsAt && endsAt <= latestEnd && latestEnd - startedAt <= LONGEST_MS)) throw new SealError('malformed', 'it ends after it starts, by its latest end, a week from its start at most');
    if (typeof parsed.secret !== 'string') throw new SealError('malformed', 'no secret');
    const secret = fromB64url(parsed.secret);
    if (secret.length !== 32) {
        secret.fill(0);
        throw new SealError('malformed', "a camera's secret is 32 bytes");
    }
    return { secret, epoch, startedAt, endsAt, latestEnd, startedByName: name ?? null };
}

/**
 * The pass, if that sender wrapped it for this camera, household and epoch,
 * and the epoch inside is the one it was wrapped as (steps 3 and 4). A
 * keyring never opens here: a pass has an info and associated data of its
 * own, so the home's keys can't arrive this way.
 * @param {{ deviceKey: import('../crypto/p256.js').DeviceKey, senderPublicKey: string, householdId: string, cameraId: string, epoch: number, wrapped: string }} how `senderPublicKey` base64url, as listed
 */
export async function openPass(how) {
    const opened = await hpkeOpen({
        mode: 'auth', recipient: how.deviceKey, senderPublicKey: fromB64url(how.senderPublicKey),
        info: PASS_INFO, aad: passAad(how.householdId, how.cameraId, how.epoch), sealed: how.wrapped,
    });
    let inside;
    try {
        let text;
        try {
            text = textOf(opened);
        } catch {
            throw new SealError('malformed', 'not UTF-8 inside');
        }
        inside = readPassInside(text);
    } finally {
        opened.fill(0);
    }
    if (inside.epoch !== how.epoch) {
        inside.secret.fill(0);
        throw new SealError('unknown_keys', 'the pass inside is for another epoch than it was wrapped as');
    }
    return inside;
}

/** A pass as the Worker hands it over (`GET /v1/me/pass`), of the right
 * shape, or a refusal: nothing vouches for one that isn't.
 * @param {unknown} listed */
function listedPass(listed) {
    const from = listed !== null && typeof listed === 'object' && !Array.isArray(listed) ? /** @type {Record<string, unknown>} */ (listed) : {};
    const { epoch, from_public_key: fromPublicKey, pass, approval_mac: approvalMac } = from;
    if (!Number.isInteger(epoch) || /** @type {number} */ (epoch) < 0 || /** @type {number} */ (epoch) > MAX_EPOCH || typeof fromPublicKey !== 'string' || typeof pass !== 'string' || typeof approvalMac !== 'string') {
        throw new SealError('not_authentic', "what was handed over isn't an approved pass");
    }
    return { epoch: /** @type {number} */ (epoch), fromPublicKey, pass, approvalMac };
}

/**
 * Takes a pass, in the order at the top of this file, and gives the camera
 * it makes: its id, its keys (which can be used and not read out), its
 * times and whoever started it. Throws a `SealError` otherwise, and nothing
 * of the pass is kept: `over` past its end, `unknown_keys` for an epoch
 * inside that isn't the one it was wrapped as, and for everything else that
 * it isn't authentic or isn't a pass.
 * @param {{
 *   deviceKey: import('../crypto/p256.js').DeviceKey,
 *   givenId: unknown,
 *   householdId: unknown,
 *   inviteId: string,
 *   invite: { approvalHolds: (inviteId: string, deviceId: string, handed: { epoch: number, from_public_key: string, pass: string, approval_mac: string }) => Promise<boolean> },
 *   listed: unknown,
 *   now: number,
 * }} how `givenId` and `householdId` as the Worker says them (`GET /v1/me`), `listed` as it hands the pass over, `invite` the keys of the link's token (src/crypto/invite.js)
 * @returns {Promise<{ cameraId: string, keys: KeySet, startedAt: number, endsAt: number, latestEndAt: number, startedBy: string | null }>}
 */
export async function takePass(how) {
    // 1. Its id is its key's, and it takes nothing under any other.
    const cameraId = await cameraIdOf(how.deviceKey.publicKey);
    if (how.givenId !== cameraId) throw new SealError('not_authentic', "the id the Worker gave this page isn't its key's");
    // 2. What was handed over came from whoever made the link.
    const listed = listedPass(how.listed);
    const vouched = await how.invite.approvalHolds(how.inviteId, cameraId, { epoch: listed.epoch, from_public_key: listed.fromPublicKey, pass: listed.pass, approval_mac: listed.approvalMac });
    if (!vouched) throw new SealError('not_authentic', "the approval isn't from whoever made the link");
    // 3 and 4. It opens as that sender's, for this household, this camera and that epoch, and says that epoch inside.
    if (typeof how.householdId !== 'string' || how.householdId === '') throw new SealError('not_authentic', 'the Worker names no household to open it for');
    const inside = await openPass({ deviceKey: how.deviceKey, senderPublicKey: listed.fromPublicKey, householdId: how.householdId, cameraId, epoch: listed.epoch, wrapped: listed.pass });
    // 5. Not past its end, by this device's own clock.
    if (!(inside.endsAt > how.now)) {
        inside.secret.fill(0);
        throw new SealError('over', 'past its end');
    }
    // Its keys, and the secret forgotten: `forCamera` wipes it.
    const keys = await KeySet.forCamera(inside.secret, inside.epoch);
    return { cameraId, keys, startedAt: inside.startedAt, endsAt: inside.endsAt, latestEndAt: inside.latestEnd, startedBy: inside.startedByName };
}
