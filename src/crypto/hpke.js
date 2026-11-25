// HPKE (RFC 9180) with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
// AES-256-GCM: the suite the apps wrap a keyring with (docs/API.md, Keys),
// CryptoKit's P256_SHA256_AES_GCM_256. Base mode and auth mode, both ways,
// on the browser's own crypto. Held to the CFRG's vectors for the suite and
// to the keyrings in docs/vectors/keyring-v1.json, CryptoKit's included.
//
// What a member hands a temporary camera, its pass, is wrapped this way in
// auth mode (docs/WEB-CAMERA.md § 3): opening one proves which device sent
// it. The recipient's private key never leaves the browser's keeping.

import { SealError, b64url, bigEndian, concat, fromB64url, utf8 } from './bytes.js';
import { dh, generateDeviceKey, looksLikePublicKey } from './p256.js';
import { gcmOpen, gcmSeal, hmac, sealingKey } from './primitives.js';

const KEM_SUITE = concat('KEM', bigEndian(0x0010, 2));
const HPKE_SUITE = concat('HPKE', bigEndian(0x0010, 2), bigEndian(0x0001, 2), bigEndian(0x0002, 2));
const MODE = Object.freeze({ base: 0x00, auth: 0x02 });
const NOTHING = new Uint8Array(0);

/** HKDF-Expand: HMAC in counter mode. @param {Uint8Array} prk @param {Uint8Array} info @param {number} length */
async function expand(prk, info, length) {
    let block = NOTHING;
    let out = NOTHING;
    for (let i = 1; out.length < length; i++) {
        block = await hmac(prk, concat(block, info, Uint8Array.of(i)));
        out = concat(out, block);
    }
    return out.subarray(0, length);
}

/** @param {Uint8Array} suite @param {Uint8Array} salt @param {string} label @param {Uint8Array} ikm */
const labeledExtract = (suite, salt, label, ikm) => hmac(salt, concat('HPKE-v1', suite, label, ikm));

/** @param {Uint8Array} suite @param {Uint8Array} prk @param {string} label @param {Uint8Array} info @param {number} length */
const labeledExpand = (suite, prk, label, info, length) => expand(prk, concat(bigEndian(length, 2), 'HPKE-v1', suite, label, info), length);

/** ExtractAndExpand over the Diffie-Hellman results. @param {Uint8Array} dhs @param {Uint8Array} kemContext */
async function kemSecret(dhs, kemContext) {
    return labeledExpand(KEM_SUITE, await labeledExtract(KEM_SUITE, NOTHING, 'eae_prk', dhs), 'shared_secret', kemContext, 32);
}

/** KeySchedule with no PSK. @param {number} mode @param {Uint8Array} sharedSecret @param {Uint8Array} info */
async function keySchedule(mode, sharedSecret, info) {
    const context = concat(
        Uint8Array.of(mode),
        await labeledExtract(HPKE_SUITE, NOTHING, 'psk_id_hash', NOTHING),
        await labeledExtract(HPKE_SUITE, NOTHING, 'info_hash', info),
    );
    const secret = await labeledExtract(HPKE_SUITE, sharedSecret, 'secret', NOTHING);
    const key = await labeledExpand(HPKE_SUITE, secret, 'key', context, 32);
    const baseNonce = await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12);
    const exporterSecret = await labeledExpand(HPKE_SUITE, secret, 'exp', context, 32);
    return { keyScheduleContext: context, secret, key, baseNonce, exporterSecret };
}

/** The nonce of message `sequence`: the base nonce XOR the sequence number.
 * @param {Uint8Array} baseNonce @param {number} sequence */
function sequenceNonce(baseNonce, sequence) {
    const nonce = Uint8Array.from(baseNonce);
    const counter = bigEndian(sequence, 6);
    for (let i = 0; i < 6; i++) nonce[6 + i] ^= counter[i];
    return nonce;
}

/** @param {string | Uint8Array} value */
const asBytes = (value) => (typeof value === 'string' ? utf8(value) : value);

/** @param {'base' | 'auth' | undefined} mode */
function modeOf(mode) {
    const chosen = mode ?? 'base';
    if (chosen !== 'base' && chosen !== 'auth') throw new SealError('malformed', 'base mode or auth mode');
    return chosen;
}

/**
 * The sender's side set up: the encapsulated key and what seals each message.
 * @param {{
 *   mode?: 'base' | 'auth',
 *   recipientPublicKey: Uint8Array,
 *   sender?: import('./p256.js').DeviceKey,
 *   ephemeral?: import('./p256.js').DeviceKey,
 *   info: string | Uint8Array,
 * }} how `sender` in auth mode; `ephemeral` for the vectors, a new key otherwise
 */
export async function hpkeSender(how) {
    const mode = modeOf(how.mode);
    const pkR = how.recipientPublicKey;
    if (!looksLikePublicKey(pkR)) throw new SealError('malformed', 'not a P-256 public key');
    const ephemeral = how.ephemeral ?? (await generateDeviceKey());
    const enc = ephemeral.publicKey;
    let dhs = await dh(ephemeral.privateKey, pkR);
    let kemContext = concat(enc, pkR);
    if (mode === 'auth') {
        if (!how.sender) throw new SealError('malformed', 'auth mode needs the sender’s key');
        // AuthEncap: DH(skE, pkR) || DH(skS, pkR), each the shared point's x.
        dhs = concat(dhs, await dh(how.sender.privateKey, pkR));
        kemContext = concat(kemContext, how.sender.publicKey);
    }
    const sharedSecret = await kemSecret(dhs, kemContext);
    const schedule = await keySchedule(MODE[mode], sharedSecret, asBytes(how.info));
    const key = await sealingKey(schedule.key, ['encrypt']);
    return {
        enc,
        sharedSecret,
        ...schedule,
        /** Message `sequence`'s ciphertext and tag.
         * @param {string | Uint8Array} plaintext @param {string | Uint8Array} aad @param {number} [sequence] */
        seal: async (plaintext, aad, sequence = 0) => (await gcmSeal(key, sequenceNonce(schedule.baseNonce, sequence), asBytes(plaintext), asBytes(aad))).subarray(12),
    };
}

/**
 * The recipient's side set up, from the encapsulated key.
 * @param {{
 *   mode?: 'base' | 'auth',
 *   recipient: import('./p256.js').DeviceKey,
 *   senderPublicKey?: Uint8Array,
 *   enc: Uint8Array,
 *   info: string | Uint8Array,
 * }} how `senderPublicKey` in auth mode
 */
export async function hpkeRecipient(how) {
    const mode = modeOf(how.mode);
    const enc = how.enc;
    if (!looksLikePublicKey(enc)) throw new SealError('malformed', 'not an encapsulated P-256 key');
    let dhs = await dh(how.recipient.privateKey, enc);
    let kemContext = concat(enc, how.recipient.publicKey);
    if (mode === 'auth') {
        if (!how.senderPublicKey) throw new SealError('malformed', 'auth mode needs the sender’s key');
        dhs = concat(dhs, await dh(how.recipient.privateKey, how.senderPublicKey));
        kemContext = concat(kemContext, how.senderPublicKey);
    }
    const sharedSecret = await kemSecret(dhs, kemContext);
    const schedule = await keySchedule(MODE[mode], sharedSecret, asBytes(how.info));
    const key = await sealingKey(schedule.key, ['decrypt']);
    return {
        sharedSecret,
        ...schedule,
        /** @param {Uint8Array} ciphertext with its tag @param {string | Uint8Array} aad @param {number} [sequence] */
        open: (ciphertext, aad, sequence = 0) => gcmOpen(key, concat(sequenceNonce(schedule.baseNonce, sequence), ciphertext), asBytes(aad)),
    };
}

/** One message sealed as the apps send HPKE output:
 * "<encapsulated key>.<ciphertext and tag>", each base64url.
 * @param {{ mode?: 'base' | 'auth', recipientPublicKey: Uint8Array, sender?: import('./p256.js').DeviceKey, ephemeral?: import('./p256.js').DeviceKey, info: string | Uint8Array, aad: string | Uint8Array, plaintext: string | Uint8Array }} how */
export async function hpkeSeal(how) {
    const sender = await hpkeSender(how);
    return `${b64url(sender.enc)}.${b64url(await sender.seal(how.plaintext, how.aad))}`;
}

/** What `hpkeSeal` sealed, opened: throws unless it was sealed for this key,
 * info and associated data (and, in auth mode, by that sender).
 * @param {{ mode?: 'base' | 'auth', recipient: import('./p256.js').DeviceKey, senderPublicKey?: Uint8Array, info: string | Uint8Array, aad: string | Uint8Array, sealed: string }} how
 * @returns {Promise<Uint8Array>} */
export async function hpkeOpen(how) {
    const parts = typeof how.sealed === 'string' ? how.sealed.split('.') : [];
    const [enc, ciphertext] = parts;
    if (parts.length !== 2 || !enc || !ciphertext) throw new SealError('unknown_version', 'not "<encapsulated key>.<ciphertext>"');
    const recipient = await hpkeRecipient({ mode: how.mode, recipient: how.recipient, senderPublicKey: how.senderPublicKey, enc: fromB64url(enc), info: how.info });
    return recipient.open(fromB64url(ciphertext), how.aad);
}

/** How a keyring is wrapped (docs/API.md, Keys): this info, and associated
 * data naming the household, who it's for and its newest epoch. No page
 * ever opens one: it is here for the vectors, which a pass must not open as. */
export const KEYRING_INFO = 'petcam.keyring.v1';

/** @param {string} household @param {string} recipient a device id, or "watch" @param {number} epoch the keyring's newest */
export const keyringAad = (household, recipient, epoch) => `petcam.keyring.v1|${household}|${recipient}|${epoch}`;

/** How the pass a temporary camera is handed is wrapped: as a keyring is,
 * under an info and associated data of its own, so a pass never opens as a
 * keyring and a keyring never as a pass. The home's keys can't arrive this
 * way (docs/API.md, Temporary cameras, The pass). */
export const PASS_INFO = 'petcam.campass.v1';

/** @param {string} household @param {string} camera the page's own device id @param {number} epoch the home's, as the camera starts */
export const passAad = (household, camera, epoch) => `petcam.campass.v1|${household}|${camera}|${epoch}`;
