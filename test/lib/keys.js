// For the vectors only: a P-256 private key given as its bytes. The page
// itself never holds one that way (its own is made by the browser and can't
// be read out), so this is with the tests and not with the page's code. The
// browser takes a private key's bytes only together with its public half,
// which the vector files give for every key they name.

import { SealError, b64url, fromB64url, fromHex } from '../../src/crypto/bytes.js';
import { KeySet } from '../../src/crypto/keys.js';

const subtle = globalThis.crypto.subtle;

/** @param {Uint8Array} privateKey 32 bytes @param {Uint8Array} publicKey X9.63 uncompressed
 * @returns {Promise<import('../../src/crypto/p256.js').DeviceKey>} */
export async function deviceKeyFromBytes(privateKey, publicKey) {
    const jwk = { kty: 'EC', crv: 'P-256', d: b64url(privateKey), x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33, 65)), ext: true };
    return { privateKey: await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']), publicKey };
}

/** A key the vector files write in base64url. @param {string} privateKey @param {string} publicKey */
export const deviceKey = (privateKey, publicKey) => deviceKeyFromBytes(fromB64url(privateKey), fromB64url(publicKey));

/** A key the CFRG's vectors write in hex. @param {string} privateKey @param {string} publicKey */
export const deviceKeyFromHex = (privateKey, publicKey) => deviceKeyFromBytes(fromHex(privateKey), fromHex(publicKey));

/** A device holding some of a vector file's epochs, as its `holders` says.
 * @param {any} file @param {string} name */
export function holder(file, name) {
    const held = file.holders[name];
    return KeySet.fromSecrets(Object.fromEntries(held.epochs.map((n) => [n, fromB64url(file.epochs[String(n)])])));
}

/** How opening went: 'opens' with what came out, or the vector files' word
 * for how it failed. @param {() => Promise<unknown>} open */
export async function outcome(open) {
    try {
        return { expect: 'opens', value: await open() };
    } catch (error) {
        if (!(error instanceof SealError)) throw error;
        const refused = error.code === 'not_authentic' || error.code === 'malformed';
        return { expect: refused ? 'refused' : error.code, ...(error.code === 'newer_keys' ? { epoch: error.epoch } : {}) };
    }
}
