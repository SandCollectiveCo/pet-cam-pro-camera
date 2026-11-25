// The keys a 32-byte secret gives, and what's sealed and signed with them
// (docs/API.md: Identity model, Sealed messages, Events, Realtime).
//
// A temporary camera holds one secret, made for it alone by the viewer that
// approved it, and never a key of the home's (docs/WEB-CAMERA.md § 3). From
// it come a box key, a media key and a signal key, by the derivation an
// epoch's secret uses, and everything the camera says is sealed and signed
// in today's formats under them. The formats are held to docs/vectors/,
// whose secrets are a made-up home's: the same derivation, the same bytes.
//
// Every key here is a CryptoKey that can't be read out. The secret itself is
// in the page's hands only while a pass is opened; `KeySet.forCamera` takes
// it, makes the keys and wipes its copy.

import { SealError, b64url, bigEndian, concat, fromB64url, fromBigEndian, textOf, utf8 } from './bytes.js';
import { deriveMacKey, deriveSealingKey, derivationKey, gcmOpen, gcmSeal, hmacVerify, hmacWith, randomBytes } from './primitives.js';

/** The HKDF info of each key a camera uses (docs/API.md, Identity model). The
 * home's other keys (join, attest, chain, the member nonces) are a member's
 * to hold, and no page ever derives one. */
export const KEY_INFO = Object.freeze({
    box: 'petcam.box.v1',
    media: 'petcam.media.v2',
    signal: 'petcam.signal.v1',
});

/** What a sealed message or sealed media is bound to: its AES-GCM associated
 * data, UTF-8, never sent. Only the kinds a camera seals or opens. */
export const SealContext = Object.freeze({
    /** @param {string} from @param {string} to @param {string} session */
    signal: (from, to, session) => `petcam.signal.v1|${from}|${to}|${session}`,
    /** @param {string} from @param {string} camera */
    command: (from, camera) => `petcam.command.v1|${from}|${camera}`,
    /** @param {string} camera */
    status: (camera) => `petcam.status.v1|${camera}`,
    /** @param {string} camera */
    peek: (camera) => `petcam.peek.v1|${camera}`,
});

/** The largest epoch a sealed header holds. */
export const MAX_EPOCH = 2 ** 31 - 1;

/** A sealed message: 0x04 || epoch (u32) || nonce(12) || ciphertext || tag(16)
 * under the box key; 0x02 with no epoch is epoch 0, from before keys could
 * change. Sealed media: 0x05 with the same layout under the media key. */
const VERSION = Object.freeze({ message: 0x04, messageEpoch0: 0x02, media: 0x05 });

/** A version byte and the epoch after it: 5 bytes. @param {number} version @param {number} epoch */
function header(version, epoch) {
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) throw new SealError('malformed', `no header holds epoch ${epoch}`);
    return concat(Uint8Array.of(version), bigEndian(epoch, 4));
}

/** The epoch a sealed blob names, and what follows its header.
 * @param {Uint8Array} sealed @param {number | null} plain the version with no epoch (epoch 0) @param {number} tagged
 * @returns {[number, Uint8Array]} */
function split(sealed, plain, tagged) {
    if (sealed.length === 0) throw new SealError('unknown_version', 'empty');
    if (plain !== null && sealed[0] === plain) return [0, sealed.subarray(1)];
    if (sealed[0] !== tagged || sealed.length <= 5) throw new SealError('unknown_version', `not version ${tagged}`);
    return [fromBigEndian(sealed.subarray(1, 5)), sealed.subarray(5)];
}

/** One secret's keys: what seals messages, what seals media, what signs an
 * offer and checks an answer. */
class EpochKeys {
    /** @param {CryptoKey} box @param {CryptoKey} media @param {CryptoKey} signal */
    constructor(box, media, signal) {
        this.box = box;
        this.media = media;
        this.signal = signal;
    }

    /** @param {Uint8Array} secret 32 bytes @param {{ opensMedia?: boolean }} [how] a camera only ever seals media */
    static async from(secret, how = {}) {
        if (secret.length !== 32) throw new SealError('malformed', 'a secret is 32 bytes');
        const base = await derivationKey(secret);
        const [box, media, signal] = await Promise.all([
            deriveSealingKey(base, KEY_INFO.box, ['encrypt', 'decrypt']),
            deriveSealingKey(base, KEY_INFO.media, how.opensMedia ? ['encrypt', 'decrypt'] : ['encrypt']),
            deriveMacKey(base, KEY_INFO.signal),
        ]);
        return new EpochKeys(box, media, signal);
    }
}

/** Keys by epoch, as a device holds them. Sealing uses the newest; opening,
 * the epoch the header names. A temporary camera's set has one epoch, the
 * home's when the camera started, for as long as it lives. */
export class KeySet {
    /** @param {Map<number, EpochKeys>} epochs @param {{ ofACamera?: boolean }} [how] */
    constructor(epochs, how = {}) {
        if (epochs.size === 0) throw new SealError('malformed', 'no epochs');
        /** @type {Map<number, EpochKeys>} */
        this.epochs = epochs;
        /** A temporary camera's own keys: one epoch, the home's when it
         * started. Under them a thing opens under that epoch only, and
         * anything else isn't that camera's (`unknown_keys`): there is no
         * "catch up" and no "older keys" for a camera (docs/API.md,
         * Temporary cameras, Its own keys). */
        this.ofACamera = how.ofACamera === true;
    }

    /** A temporary camera's own keys, from the secret in its pass. The
     * caller's copy of the secret is wiped: from here on there are only keys
     * that can be used and not read.
     * @param {Uint8Array} secret 32 bytes @param {number} epoch the home's epoch when the camera started */
    static async forCamera(secret, epoch) {
        try {
            return new KeySet(new Map([[epoch, await EpochKeys.from(secret)]]), { ofACamera: true });
        } finally {
            secret.fill(0);
        }
    }

    /** Several epochs' keys, which is how the vectors' holders hold them. No
     * page holds a home's: this is for docs/vectors/ and nothing else.
     * `ofACamera`: one camera's keys as a member holds them from its entry,
     * which open its stills as the page's own never do.
     * @param {Record<number, Uint8Array>} secrets epoch → secret @param {{ ofACamera?: boolean }} [how] */
    static async fromSecrets(secrets, how = {}) {
        const epochs = new Map();
        for (const [n, secret] of Object.entries(secrets)) epochs.set(Number(n), await EpochKeys.from(secret, { opensMedia: true }));
        return new KeySet(epochs, how);
    }

    /** What a page keeps between visits: the keys themselves, which the
     * browser stores without ever showing their bytes (store.js). */
    kept() {
        return [...this.epochs].map(([epoch, keys]) => ({ epoch, box: keys.box, media: keys.media, signal: keys.signal }));
    }

    /** The keys a page kept, brought back. What storage hands over is
     * checked, not trusted: an origin's storage is the origin's, not the
     * page's alone. Anything that isn't exactly what `kept` writes for a
     * camera (one epoch's keys, of the right kinds, for the right uses, that
     * can't be read out, under a whole epoch) is refused, and the camera it
     * was for is over.
     * @param {{ epoch: number, box: CryptoKey, media: CryptoKey, signal: CryptoKey }[]} kept */
    static fromKept(kept) {
        if (!Array.isArray(kept) || kept.length !== 1) throw new SealError('malformed', "what was kept isn't one camera's keys");
        const isKey = (key, name, uses) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey && key.type === 'secret' && key.extractable === false
            && key.algorithm?.name === name && key.usages.length > 0 && key.usages.every((use) => uses.includes(use));
        const epochs = new Map();
        for (const k of kept) {
            const whole = k !== null && typeof k === 'object' && Number.isInteger(k.epoch) && k.epoch >= 0 && k.epoch <= MAX_EPOCH && !epochs.has(k.epoch);
            if (!whole || !isKey(k.box, 'AES-GCM', ['encrypt', 'decrypt']) || !isKey(k.media, 'AES-GCM', ['encrypt', 'decrypt']) || !isKey(k.signal, 'HMAC', ['sign', 'verify'])) throw new SealError('malformed', "what was kept isn't a camera's keys");
            epochs.set(k.epoch, new EpochKeys(k.box, k.media, k.signal));
        }
        return new KeySet(epochs, { ofACamera: true });
    }

    /** The newest epoch: what everything is sealed with. */
    get epoch() {
        return Math.max(...this.epochs.keys());
    }

    /** @param {number} epoch @returns {EpochKeys} */
    #keys(epoch) {
        const keys = this.epochs.get(epoch);
        if (!keys) {
            if (epoch > this.epoch) throw new SealError('newer_keys', `sealed under epoch ${epoch}, newer than these keys' ${this.epoch}`, epoch);
            throw new SealError('unknown_keys', `sealed under epoch ${epoch}, which these keys don't hold`);
        }
        return keys;
    }

    // ---- Messages ---------------------------------------------------------

    /** Seals `text` (a message's snake_case JSON) for `context`.
     * @param {string} text @param {string} context
     * @param {{ nonce?: Uint8Array, epoch?: number }} [how] a nonce and an epoch, for the vectors
     * @returns {Promise<{ sealed: string }>} */
    async sealText(text, context, how = {}) {
        const epoch = how.epoch ?? this.epoch;
        const body = await gcmSeal(this.#keys(epoch).box, how.nonce ?? randomBytes(12), utf8(text), context);
        return { sealed: b64url(concat(header(VERSION.message, epoch), body)) };
    }

    /** @param {unknown} value @param {string} context @param {{ nonce?: Uint8Array, epoch?: number }} [how] */
    sealMessage(value, context, how = {}) {
        return this.sealText(JSON.stringify(value), context, how);
    }

    /** The JSON text inside a sealed message. `fresh`: only under the current
     * epoch, which is how everything a device acts on is opened.
     * @param {{ sealed: string }} message @param {string} context @param {{ fresh?: boolean }} [how]
     * @returns {Promise<string>} */
    async openText(message, context, how = {}) {
        let data;
        try {
            data = fromB64url(message.sealed);
        } catch {
            throw new SealError('unknown_version', 'not base64url');
        }
        const [epoch, body] = split(data, VERSION.messageEpoch0, VERSION.message);
        if (this.ofACamera && epoch !== this.epoch) throw new SealError('unknown_keys', `sealed under epoch ${epoch}, not this camera's ${this.epoch}`);
        if (epoch > this.epoch) throw new SealError('newer_keys', `sealed under epoch ${epoch}, newer than these keys' ${this.epoch}`, epoch);
        if (how.fresh && epoch !== this.epoch) throw new SealError('stale_keys', `sealed under epoch ${epoch}, older than the current ${this.epoch}`);
        const opened = await gcmOpen(this.#keys(epoch).box, body, context);
        try {
            return textOf(opened);
        } catch {
            throw new SealError('malformed', 'not UTF-8 inside');
        }
    }

    /** @param {{ sealed: string }} message @param {string} context @param {{ fresh?: boolean }} [how] @returns {Promise<any>} */
    async openMessage(message, context, how = {}) {
        const text = await this.openText(message, context, how);
        try {
            return JSON.parse(text);
        } catch {
            throw new SealError('malformed', 'not JSON inside');
        }
    }

    /** The epoch a sealed message names, or null. @param {{ sealed: string }} message */
    static epochOfMessage(message) {
        try {
            return split(fromB64url(message.sealed), VERSION.messageEpoch0, VERSION.message)[0];
        } catch {
            return null;
        }
    }

    // ---- Media ------------------------------------------------------------

    /** 0x05 || epoch (u32) || nonce(12) || ciphertext || tag(16) under the
     * media key, bound to what it is (SealContext.peek).
     * @param {Uint8Array} plaintext @param {string} context @param {{ nonce?: Uint8Array, epoch?: number }} [how]
     * @returns {Promise<Uint8Array>} */
    async sealMedia(plaintext, context, how = {}) {
        const epoch = how.epoch ?? this.epoch;
        return concat(header(VERSION.media, epoch), await gcmSeal(this.#keys(epoch).media, how.nonce ?? randomBytes(12), plaintext, context));
    }

    /** What `sealMedia` sealed. A camera never opens media (its media key only
     * seals); this is what the vectors' holders do, kept so the format is
     * held to them from both sides. `epoch`: only under that one; `fresh`:
     * only under the current one. The unbound formats from before (0x03,
     * 0x01) don't open.
     * @param {Uint8Array} sealed @param {string} context @param {{ epoch?: number, fresh?: boolean }} [how]
     * @returns {Promise<Uint8Array>} */
    async openMedia(sealed, context, how = {}) {
        if (sealed[0] !== VERSION.media) throw new SealError('unknown_version', 'not media the apps open (0x05)');
        const [epoch, body] = split(sealed, null, VERSION.media);
        if (this.ofACamera && epoch !== this.epoch) throw new SealError('unknown_keys', `sealed under epoch ${epoch}, not this camera's ${this.epoch}`);
        if (how.fresh && epoch !== this.epoch) {
            if (epoch > this.epoch) throw new SealError('newer_keys', `sealed under epoch ${epoch}, newer than these keys' ${this.epoch}`, epoch);
            throw new SealError('stale_keys', `sealed under epoch ${epoch}, older than the current ${this.epoch}`);
        }
        if (how.epoch !== undefined && epoch !== how.epoch) throw new SealError('unknown_keys', `sealed under epoch ${epoch}, not its event's ${how.epoch}`);
        return gcmOpen(this.#keys(epoch).media, body, context);
    }

    /** The epoch sealed media names (0x05), or null. @param {Uint8Array} sealed */
    static epochOfMedia(sealed) {
        if (sealed[0] !== VERSION.media) return null;
        try {
            return split(sealed, null, VERSION.media)[0];
        } catch {
            return null;
        }
    }

    // ---- Signalling -------------------------------------------------------

    /** An offer's or an answer's `sig`: base64url HMAC-SHA256 under the
     * current epoch's signal key. @param {string} text "<session>|<kind>|<sdp>" */
    async sign(text) {
        return b64url(await hmacWith(this.#keys(this.epoch).signal, text));
    }

    /** @param {string} text @param {unknown} signature base64url, as it came */
    async verify(text, signature) {
        if (typeof signature !== 'string') return false;
        let mac;
        try {
            mac = fromB64url(signature);
        } catch {
            return false;
        }
        if (mac.length !== 32) return false;
        return hmacVerify(this.#keys(this.epoch).signal, text, mac);
    }
}
