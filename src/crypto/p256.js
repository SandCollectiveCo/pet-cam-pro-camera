// The page's own P-256 key (docs/API.md, Identity model: each device has its
// own key pair). The browser makes it not extractable: the page can agree
// keys with it and can never read the private half, so a script that got
// into the page couldn't carry it away (docs/WEB-CAMERA.md § 3, § 11).

import { SealError } from './bytes.js';

const subtle = globalThis.crypto.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

/** A device key: the private half as a key that can only be used, the public
 * half as everyone sees it (X9.63 uncompressed, 65 bytes).
 * @typedef {{ privateKey: CryptoKey, publicKey: Uint8Array }} DeviceKey */

/** A new key pair, its private half never readable. @returns {Promise<DeviceKey>} */
export async function generateDeviceKey() {
    const pair = await subtle.generateKey(CURVE, false, ['deriveBits']);
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

/** Whether these are the 65 bytes of an uncompressed P-256 point. The
 * browser checks the point is on the curve when it's used.
 * @param {Uint8Array} raw */
export const looksLikePublicKey = (raw) => raw.length === 65 && raw[0] === 0x04;

/** The x coordinate of the shared point: what HPKE's DHKEM calls DH().
 * @param {CryptoKey} privateKey @param {Uint8Array} publicKey X9.63 uncompressed
 * @returns {Promise<Uint8Array>} 32 bytes */
export async function dh(privateKey, publicKey) {
    if (!looksLikePublicKey(publicKey)) throw new SealError('malformed', 'not a P-256 public key');
    let theirs;
    try {
        theirs = await subtle.importKey('raw', publicKey, CURVE, false, []);
    } catch {
        throw new SealError('malformed', 'not a P-256 public key');
    }
    return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256));
}
