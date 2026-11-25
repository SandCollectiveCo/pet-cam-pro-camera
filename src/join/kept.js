// What a temporary camera keeps between visits, as one record in the
// browser's own storage (src/crypto/store.js): its own key pair, its
// session with the Worker, and either the request it is waiting on or the
// camera it became. Never both, and never a token, a secret or a key of the
// home's: the keys are ones the browser stores without showing their bytes.
//
// The record is written whole each time, so what is read back is one
// moment's and never half of two.
//
// An origin's storage belongs to everything served from that origin, so
// what is read back is checked and not trusted (`readKept`): keys of the
// right kinds, for the right uses, that can't be read out; an id that is
// its key's; times a temporary camera can have. Anything else is nothing
// kept, and the camera it was for is over.

import { inviteKeysFromKept } from '../crypto/invite.js';
import { KeySet } from '../crypto/keys.js';
import { cameraIdOf } from './id.js';
import { LONGEST_MS } from './pass.js';

/** The one name the record is kept under. */
export const KEPT_KEY = 'camera';
const VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** The longest token or name it reads back: far more than either is. */
const MAX_TEXT = 4_096;
/** The most command ids it reads back: a camera keeps five minutes of them. */
const MAX_SEEN = 2_000;

/**
 * A session with the Worker (docs/API.md, Sessions), as the page holds one.
 * @typedef {{ accessToken: string, refreshToken: string, expiresAt: number }} KeptSession
 */

/**
 * The request it is waiting on.
 * @typedef {object} Asking
 * @property {string} inviteId
 * @property {NonNullable<ReturnType<typeof inviteKeysFromKept>>} invite the link's keys: never its token
 * @property {Uint8Array} nonce the 32 bytes its request committed to
 * @property {string} commitment
 * @property {boolean} asked whether its request reached the Worker
 * @property {string | null} memberNonce the member's answer it revealed its nonce for
 */

/**
 * The camera it became.
 * @typedef {object} Became
 * @property {string} inviteId the invite it got in by: a link to the same one is nothing new
 * @property {KeySet} keys its own, which can be used and not read out
 * @property {number} startedAt
 * @property {number} endsAt
 * @property {number} latestEndAt
 * @property {string | null} startedBy
 * @property {Record<string, number>} seen the command ids it carried out, and when
 */

/**
 * Everything this browser holds of one camera, live.
 * @typedef {object} Held
 * @property {string} deviceId its key's (src/join/id.js)
 * @property {import('../crypto/p256.js').DeviceKey} deviceKey
 * @property {KeptSession | null} session null until it has registered
 * @property {Asking | null} asking
 * @property {Became | null} camera
 */

class NotKept extends Error {}

/** @param {unknown} ok */
function need(ok) {
    if (!ok) throw new NotKept();
}

/** @param {unknown} value @returns {Record<string, any>} */
function plain(value) {
    need(value !== null && typeof value === 'object' && !Array.isArray(value));
    return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} text */
const isText = (text) => typeof text === 'string' && text !== '' && text.length <= MAX_TEXT;
/** @param {unknown} at */
const isTime = (at) => Number.isSafeInteger(at) && /** @type {number} */ (at) >= 0;
/** @param {unknown} key */
const isCryptoKey = (key) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey;

/** The page's own private key, as the browser made it: P-256, for agreeing
 * keys and nothing else, and not readable. @param {unknown} key */
const isOwnPrivateKey = (key) => isCryptoKey(key) && /** @type {any} */ (key).type === 'private' && /** @type {any} */ (key).extractable === false
    && /** @type {any} */ (key).algorithm?.name === 'ECDH' && /** @type {any} */ (key).algorithm?.namedCurve === 'P-256'
    && /** @type {any} */ (key).usages.length === 1 && /** @type {any} */ (key).usages[0] === 'deriveBits';

/** What goes into storage for what is held: plain values, and keys the
 * browser keeps as keys. @param {Held} held */
export function toKeep(held) {
    return {
        v: VERSION,
        deviceId: held.deviceId,
        deviceKey: { privateKey: held.deviceKey.privateKey, publicKey: held.deviceKey.publicKey },
        session: held.session ? { accessToken: held.session.accessToken, refreshToken: held.session.refreshToken, expiresAt: held.session.expiresAt } : null,
        asking: held.asking ? {
            inviteId: held.asking.inviteId, invite: held.asking.invite.kept(), nonce: held.asking.nonce, commitment: held.asking.commitment,
            asked: held.asking.asked, memberNonce: held.asking.memberNonce,
        } : null,
        camera: held.camera ? {
            inviteId: held.camera.inviteId, keys: held.camera.keys.kept(), startedAt: held.camera.startedAt, endsAt: held.camera.endsAt,
            latestEndAt: held.camera.latestEndAt, startedBy: held.camera.startedBy, seen: { ...held.camera.seen },
        } : null,
    };
}

/**
 * What storage handed back, as what is held, or null for anything that
 * isn't exactly what `toKeep` writes for one camera.
 * @param {unknown} value
 * @returns {Promise<Held | null>}
 */
export async function readKept(value) {
    try {
        return await checked(value);
    } catch (error) {
        // Not what it kept (or not a key at all, a set of keys that isn't a camera's): nothing.
        if (error instanceof NotKept || error?.name === 'SealError') return null;
        throw error;
    }
}

/** @param {unknown} value @returns {Promise<Held>} */
async function checked(value) {
    const record = plain(value);
    need(record.v === VERSION);
    const pair = plain(record.deviceKey);
    need(isOwnPrivateKey(pair.privateKey) && pair.publicKey instanceof Uint8Array);
    // Its id is its key's: an id that isn't is nobody this page ever was.
    const deviceId = await cameraIdOf(pair.publicKey);
    need(record.deviceId === deviceId);

    /** @type {KeptSession | null} */
    let session = null;
    if (record.session !== null) {
        const kept = plain(record.session);
        need(isText(kept.accessToken) && isText(kept.refreshToken) && isTime(kept.expiresAt));
        session = { accessToken: kept.accessToken, refreshToken: kept.refreshToken, expiresAt: kept.expiresAt };
    }

    /** @type {Asking | null} */
    let asking = null;
    if (record.asking !== null) {
        const kept = plain(record.asking);
        const invite = inviteKeysFromKept(kept.invite);
        need(invite !== null && typeof kept.inviteId === 'string' && UUID.test(kept.inviteId));
        need(kept.nonce instanceof Uint8Array && kept.nonce.length === 32 && typeof kept.commitment === 'string' && NONCE_TEXT.test(kept.commitment));
        need(typeof kept.asked === 'boolean' && (kept.memberNonce === null || (typeof kept.memberNonce === 'string' && NONCE_TEXT.test(kept.memberNonce))));
        asking = { inviteId: kept.inviteId, invite: /** @type {NonNullable<typeof invite>} */ (invite), nonce: kept.nonce, commitment: kept.commitment, asked: kept.asked, memberNonce: kept.memberNonce };
    }

    /** @type {Became | null} */
    let camera = null;
    if (record.camera !== null) {
        const kept = plain(record.camera);
        need(typeof kept.inviteId === 'string' && UUID.test(kept.inviteId));
        need(isTime(kept.startedAt) && isTime(kept.endsAt) && isTime(kept.latestEndAt));
        // The pass's own rule, again: no end past its latest, none later than a week from its start.
        need(kept.startedAt < kept.endsAt && kept.endsAt <= kept.latestEndAt && kept.latestEndAt - kept.startedAt <= LONGEST_MS);
        need(kept.startedBy === null || (typeof kept.startedBy === 'string' && kept.startedBy.length <= MAX_TEXT));
        const seen = plain(kept.seen);
        const ids = Object.entries(seen);
        need(ids.length <= MAX_SEEN && ids.every(([id, at]) => id.length <= 128 && isTime(at)));
        // One epoch's keys, of the right kinds, for the right uses, that can't be read out: or a throw.
        camera = { inviteId: kept.inviteId, keys: KeySet.fromKept(kept.keys), startedAt: kept.startedAt, endsAt: kept.endsAt, latestEndAt: kept.latestEndAt, startedBy: kept.startedBy, seen: Object.fromEntries(ids) };
    }

    // It is asking or it is a camera, never both and never neither; and a camera has a session to be one with.
    need((asking === null) !== (camera === null));
    need(camera === null || session !== null);
    return { deviceId, deviceKey: { privateKey: pair.privateKey, publicKey: pair.publicKey }, session, asking, camera };
}
