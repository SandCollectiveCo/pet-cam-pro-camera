// What a device that asks to join does with an invite's token (docs/API.md,
// Invites): the proof that it holds the link, the nonce it commits to, the
// six digits both devices show, and the check that what it's handed came
// from whoever made the link. A camera invite is this protocol whole, with a
// pass in a keyring's place at its end (docs/WEB-CAMERA.md § 3).
//
// Only the asking side is here. Answering a request, working out a listed
// request's code and approving one are a member's, done with the home's
// keys, which a page never holds.

import { SealError, b64url, fromB64url, fromBigEndian } from './bytes.js';
import { derivationKey, deriveMacKey, hmacVerify, hmacWith, sha256 } from './primitives.js';

const INFO = Object.freeze({
    proof: 'petcam.invite.proof.v1',
    code: 'petcam.invite.code.v1',
    approve: 'petcam.invite.approve.v1',
});

/** An invite's token as keys the page can use and not read: one for each
 * thing the token vouches for. The caller's copy of the token is wiped.
 * @param {Uint8Array} token 32 bytes */
export async function inviteKeys(token) {
    if (token.length !== 32) throw new SealError('malformed', 'an invite token is 32 bytes');
    try {
        // What the Worker is shown to find the invite: a hash of the token's
        // text, never the token.
        const tokenHash = b64url(await sha256(b64url(token)));
        const base = await derivationKey(token);
        const [proof, code, approve] = await Promise.all([
            deriveMacKey(base, INFO.proof, ['sign']),
            deriveMacKey(base, INFO.code, ['sign']),
            deriveMacKey(base, INFO.approve, ['verify']),
        ]);
        return new InviteKeys(tokenHash, proof, code, approve);
    } finally {
        token.fill(0);
    }
}

/** What the server keeps of an invite's token, and what an asking device
 * presents (`token_check`): SHA-256 of the token's base64url text.
 * @param {Uint8Array} token */
export const inviteTokenHash = async (token) => b64url(await sha256(b64url(token)));

/** What a request commits to, as every app makes it: SHA-256 of its nonce.
 * @param {Uint8Array} nonce 32 random bytes */
export const nonceCommitment = async (nonce) => b64url(await sha256(nonce));

/** A commitment over the key too, which members and the Worker also take,
 * though no app makes one. @param {Uint8Array} nonce @param {string} publicKey base64url */
export const nonceCommitmentWithKey = async (nonce, publicKey) => b64url(await sha256(`petcam.invite.commit.v2|${publicKey}|${b64url(nonce)}`));

/** Six digits with a space after the third, from a MAC's first four bytes. @param {Uint8Array} mac */
function sixDigits(mac) {
    const digits = String(fromBigEndian(mac.subarray(0, 4)) % 1_000_000).padStart(6, '0');
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** @param {unknown} key @param {'sign' | 'verify'} use */
const isMacKeyFor = (key, use) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey && key.type === 'secret' && key.extractable === false
    && key.algorithm?.name === 'HMAC' && key.usages.length === 1 && key.usages[0] === use;

/** An invite's keys from what a page kept of them (`kept`, below), or null:
 * what storage hands over is checked, not trusted. Anything that isn't a
 * token's hash and three keys of the right kind, each for its one use and
 * none of them readable, is nothing.
 * @param {unknown} kept @returns {InviteKeys | null} */
export function inviteKeysFromKept(kept) {
    if (kept === null || typeof kept !== 'object') return null;
    const { tokenHash, proofKey, codeKey, approveKey } = /** @type {Record<string, any>} */ (kept);
    if (typeof tokenHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) return null;
    if (!isMacKeyFor(proofKey, 'sign') || !isMacKeyFor(codeKey, 'sign') || !isMacKeyFor(approveKey, 'verify')) return null;
    return new InviteKeys(tokenHash, proofKey, codeKey, approveKey);
}

class InviteKeys {
    /** @param {string} tokenHash @param {CryptoKey} proof @param {CryptoKey} code @param {CryptoKey} approve */
    constructor(tokenHash, proof, code, approve) {
        this.tokenHash = tokenHash;
        this.proofKey = proof;
        this.codeKey = code;
        this.approveKey = approve;
    }

    /** What a page keeps of a link until its request is settled, so a
     * reload doesn't lose it: the token's hash and the three keys, which
     * the browser stores without showing their bytes. Never the token. */
    kept() {
        return { tokenHash: this.tokenHash, proofKey: this.proofKey, codeKey: this.codeKey, approveKey: this.approveKey };
    }

    /** The asking device's proof that it holds the link: the approving device
     * checks it, so the server can't swap in a key of its own.
     * @param {string} inviteId @param {string} publicKey base64url @param {string} commitment */
    async proof(inviteId, publicKey, commitment) {
        return b64url(await hmacWith(this.proofKey, `${inviteId}|${publicKey}|${commitment}`));
    }

    /** The code both devices show, "123 456".
     * @param {string} inviteId @param {string} publicKey base64url @param {Uint8Array} joinerNonce @param {string} memberNonce base64url, as the member sent it */
    async code(inviteId, publicKey, joinerNonce, memberNonce) {
        return sixDigits(await hmacWith(this.codeKey, `${inviteId}|${publicKey}|${b64url(joinerNonce)}|${memberNonce}`));
    }

    /** Whether an approval's MAC holds under the link's token: whether what
     * was handed over came from whoever made the link. A camera invite
     * hands over a `pass` where a member's hands over a keyring (`wrapped`);
     * the MAC is the invite's own either way, over
     * `<invite id>|<device id>|<epoch>|<approver's public key>|<what was handed>`.
     * @param {string} inviteId @param {string} deviceId this device's
     * @param {{ epoch: number, from_public_key: string, pass?: string, wrapped?: string, approval_mac: string | null }} handed as the server lists it */
    async approvalHolds(inviteId, deviceId, handed) {
        if (typeof handed.approval_mac !== 'string') return false;
        const carried = handed.pass ?? handed.wrapped;
        if (typeof carried !== 'string') return false;
        let mac;
        try {
            mac = fromB64url(handed.approval_mac);
        } catch {
            return false;
        }
        if (mac.length !== 32) return false;
        return hmacVerify(this.approveKey, `${inviteId}|${deviceId}|${handed.epoch}|${handed.from_public_key}|${carried}`, mac);
    }
}
