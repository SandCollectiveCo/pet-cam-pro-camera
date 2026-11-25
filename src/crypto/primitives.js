// The browser's own crypto (Web Crypto), and nothing else: SHA-256,
// HMAC-SHA256, HKDF-SHA256 with the apps' salt, and AES-256-GCM laid out as
// the apps lay it out, nonce(12) || ciphertext || tag(16).
//
// Keys are CryptoKey objects made not extractable: the page can use one and
// can't read its bytes out, and neither can whatever script ends up running
// in the page (docs/WEB-CAMERA.md § 3, § 11).

import { SealError, concat, utf8 } from './bytes.js';

const subtle = globalThis.crypto.subtle;

/** The salt of every key the apps derive (docs/API.md, Identity model). */
const SALT = utf8('petcam');

/** @param {number} length @returns {Uint8Array} */
export function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** A lowercase UUID, as every id on the wire is. */
export const randomId = () => globalThis.crypto.randomUUID().toLowerCase();

/** @param {Uint8Array | string} data text is taken as UTF-8 @returns {Promise<Uint8Array>} */
export async function sha256(data) {
    return new Uint8Array(await subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data));
}

/** Key bytes as an HMAC-SHA256 key that can't be read back out. An empty key
 * is 32 zero bytes: HMAC pads a short key with zeros, so the two are the same
 * key, and Web Crypto won't import an empty one.
 * @param {Uint8Array} raw @param {KeyUsage[]} [usages] */
export function hmacKey(raw, usages = ['sign', 'verify']) {
    return subtle.importKey('raw', raw.length === 0 ? new Uint8Array(32) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/** @param {CryptoKey} key @param {Uint8Array | string} message @returns {Promise<Uint8Array>} */
export async function hmacWith(key, message) {
    return new Uint8Array(await subtle.sign('HMAC', key, typeof message === 'string' ? utf8(message) : message));
}

/** Whether `mac` is the HMAC of `message`, compared by the browser in constant time.
 * @param {CryptoKey} key @param {Uint8Array | string} message @param {Uint8Array} mac */
export function hmacVerify(key, message, mac) {
    return subtle.verify('HMAC', key, mac, typeof message === 'string' ? utf8(message) : message);
}

/** HMAC-SHA256 under key bytes. @param {Uint8Array} raw @param {Uint8Array | string} message */
export async function hmac(raw, message) {
    return hmacWith(await hmacKey(raw, ['sign']), message);
}

/** Secret bytes as the start of a derivation: usable for `derive*`, not readable.
 * @param {Uint8Array} secret */
export function derivationKey(secret) {
    return subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

/** @param {string} info */
const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: utf8(info) });

/** HKDF-SHA256(secret, salt "petcam", info), 32 bytes, as bytes: only for what
 * has to leave as text (nothing a camera keeps) and for the tests.
 * @param {CryptoKey} base from `derivationKey` @param {string} info @returns {Promise<Uint8Array>} */
export async function deriveBytes(base, info) {
    return new Uint8Array(await subtle.deriveBits(hkdf(info), base, 256));
}

/** The same 32 bytes as an AES-256-GCM key, never as bytes.
 * @param {CryptoKey} base @param {string} info @param {KeyUsage[]} usages */
export function deriveSealingKey(base, info, usages) {
    return subtle.deriveKey(hkdf(info), base, { name: 'AES-GCM', length: 256 }, false, usages);
}

/** The same 32 bytes as an HMAC-SHA256 key, never as bytes.
 * @param {CryptoKey} base @param {string} info @param {KeyUsage[]} [usages] */
export function deriveMacKey(base, info, usages = ['sign', 'verify']) {
    return subtle.deriveKey(hkdf(info), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, usages);
}

/** 32 bytes as an AES-256-GCM key that can't be read back out.
 * @param {Uint8Array} raw @param {KeyUsage[]} usages */
export function sealingKey(raw, usages) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

/** @param {Uint8Array} nonce @param {string | Uint8Array | null} aad */
function gcm(nonce, aad) {
    const params = { name: 'AES-GCM', iv: nonce, tagLength: 128 };
    return aad === null ? params : { ...params, additionalData: typeof aad === 'string' ? utf8(aad) : aad };
}

/** nonce(12) || ciphertext || tag(16).
 * @param {CryptoKey} key @param {Uint8Array} nonce 12 bytes @param {Uint8Array} plaintext
 * @param {string | Uint8Array | null} aad what it's bound to, never sent @returns {Promise<Uint8Array>} */
export async function gcmSeal(key, nonce, plaintext, aad) {
    if (nonce.length !== 12) throw new SealError('malformed', 'a nonce is 12 bytes');
    return concat(nonce, new Uint8Array(await subtle.encrypt(gcm(nonce, aad), key, plaintext)));
}

/** What `gcmSeal` sealed: throws `not_authentic` for the wrong key or
 * context, or anything altered.
 * @param {CryptoKey} key @param {Uint8Array} body nonce || ciphertext || tag
 * @param {string | Uint8Array | null} aad @returns {Promise<Uint8Array>} */
export async function gcmOpen(key, body, aad) {
    if (body.length < 12 + 16) throw new SealError('malformed', 'shorter than a nonce and a tag');
    try {
        return new Uint8Array(await subtle.decrypt(gcm(body.subarray(0, 12), aad), key, body.subarray(12)));
    } catch {
        throw new SealError('not_authentic', "it didn't open: the wrong key or context, or it was altered");
    }
}
