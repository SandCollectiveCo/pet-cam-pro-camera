// A temporary camera's device id, which is its key's and nobody's to pick
// (docs/API.md, Temporary cameras, Its row; vectors/temporary-camera-v1.json,
// `device_id`): SHA-256 over the UTF-8 of "petcam.tempcam.id.v1|" followed
// by the key's 65 bytes (X9.63 uncompressed), cut to its first 16 bytes,
// with the version set to 8 and the variant to RFC 9562's, written as a
// lowercase UUID.
//
// The Worker picks every other device's id at random. If it picked a page's
// too, it could list a page under the id of one of the home's own cameras.
// So the page works its id out before it registers, compares it with what
// the Worker answers, and takes nothing (no session, no pass) under any
// other.

import { SealError, concat, hex } from '../crypto/bytes.js';
import { looksLikePublicKey } from '../crypto/p256.js';
import { sha256 } from '../crypto/primitives.js';

const PREFIX = 'petcam.tempcam.id.v1|';

/** The id a page's key makes. Throws for anything that isn't a key: 65 bytes,
 * the first 0x04. @param {Uint8Array} publicKey X9.63 uncompressed */
export async function cameraIdOf(publicKey) {
    if (!(publicKey instanceof Uint8Array) || !looksLikePublicKey(publicKey)) throw new SealError('malformed', 'not a P-256 public key');
    const bytes = (await sha256(concat(PREFIX, publicKey))).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const digits = hex(bytes);
    return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
}

/** Whether `id` is the id `publicKey` makes: what the page asks of every id
 * the Worker hands it for itself. @param {unknown} id @param {Uint8Array} publicKey */
export async function isItsKeys(id, publicKey) {
    try {
        return typeof id === 'string' && id === (await cameraIdOf(publicKey));
    } catch {
        return false;
    }
}
