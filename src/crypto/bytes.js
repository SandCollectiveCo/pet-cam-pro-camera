// Bytes and text, as everything on the wire writes them (docs/API.md):
// base64url without padding, UTF-8, big-endian numbers.

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** Why something didn't open, or couldn't be made. `code` is one of
 * `unknown_version` (not a format the page opens), `newer_keys` (sealed under
 * an epoch past the newest held; `epoch` says which), `stale_keys` (an older
 * epoch, where only the current one counts), `unknown_keys` (an epoch not
 * held, or not the one asked for), `not_authentic` (the wrong key or
 * context, or altered), `malformed`, and for a pass `over` (past its end).
 * The same words the apps' scripts use
 * (server/scripts/petcam-crypto.mjs), so the vectors read the same here. */
export class SealError extends Error {
    /** @param {string} code @param {string} message @param {number} [epoch] */
    constructor(code, message, epoch) {
        super(message);
        this.name = 'SealError';
        this.code = code;
        this.epoch = epoch;
    }
}

/** @param {string} text @returns {Uint8Array} */
export const utf8 = (text) => encoder.encode(text);

/** UTF-8 text, or a throw for bytes that aren't. @param {Uint8Array} bytes */
export const textOf = (bytes) => strictDecoder.decode(bytes);

/** @param {ArrayBuffer | ArrayBufferView} data @returns {Uint8Array} a view, not a copy */
export function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
}

/** @param {...(Uint8Array | string)} parts text is taken as UTF-8 @returns {Uint8Array} */
export function concat(...parts) {
    const chunks = parts.map((part) => (typeof part === 'string' ? utf8(part) : part));
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SEXTET = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) SEXTET[ALPHABET.charCodeAt(i)] = i;
SEXTET['+'.charCodeAt(0)] = 62;
SEXTET['/'.charCodeAt(0)] = 63;

/** base64url without padding. @param {Uint8Array} bytes */
export function b64url(bytes) {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    if (i + 1 === bytes.length) {
        const n = bytes[i] << 16;
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
    } else if (i + 2 === bytes.length) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
    }
    return out;
}

/** The bytes of base64url text. The standard alphabet and padding read too,
 * as the apps read them; anything else throws.
 * @param {string} value @returns {Uint8Array} */
export function fromB64url(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) throw new SealError('malformed', 'not base64url');
    const digits = value.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((digits.length * 6) / 8));
    let bits = 0;
    let held = 0;
    let at = 0;
    for (let i = 0; i < digits.length; i++) {
        held = (held << 6) | SEXTET[digits.charCodeAt(i)];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[at++] = (held >> bits) & 0xff;
        }
    }
    return out;
}

/** Lowercase hex. @param {Uint8Array} bytes */
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {string} text an even number of hex digits @returns {Uint8Array} */
export function fromHex(text) {
    if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new SealError('malformed', 'not hex');
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Whether two byte strings are the same. Every byte is looked at whatever
 * the first difference, though nothing secret is compared with this: MACs
 * are checked by the browser's own `verify`.
 * @param {Uint8Array} a @param {Uint8Array} b */
export function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
}

/** `n` as `length` big-endian bytes. @param {number} n a whole number below 2^53 @param {number} length */
export function bigEndian(n, length) {
    const out = new Uint8Array(length);
    let rest = n;
    for (let i = length - 1; i >= 0; i--) {
        out[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }
    return out;
}

/** The whole number big-endian `bytes` hold: exact up to 2^53.
 * @param {Uint8Array} bytes */
export function fromBigEndian(bytes) {
    let n = 0;
    for (const byte of bytes) n = n * 256 + byte;
    return n;
}
