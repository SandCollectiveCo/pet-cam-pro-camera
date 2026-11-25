// A release's list of files, and the document it is served in, as the
// contract pins them (docs/API.md, The camera page;
// vectors/page-release-v1.json):
//
//   release.json   { "v": 1, "list": "<the list, as text>", "signatures": [ … ] }
//   the list       { "v": 1, "page": "<the page's address, ending in />",
//                    "release": <1 … 2^31 − 1, rising>, "entry": "index.html",
//                    "files": [ { "path", "sha256" (lowercase hex), "bytes" } ] }
//
// A signature is ECDSA over P-256 with SHA-256, over the UTF-8 of
// `petcam.release.v1|` followed by the list's text exactly as served,
// written as r then s (64 bytes, not DER), by a key kept on one Mac and in
// no file. A build signs nothing: it writes the document with no
// signatures, which no viewer takes, and signing is a step of its own, at
// release, with that key.
//
// The list rides as text so that what is signed is what is read. This file
// is the one place that text is written, so the same files always give the
// same text.
//
// It is also where a release is checked as a viewer's app checks one before
// it shows a code (`checkRelease`, `checkServed`), held to the same vectors
// as the apps: so that what a build writes, once signed, is known to be
// something a viewer takes before anything is published.

import { b64url, fromB64url, utf8 } from '../src/crypto/bytes.js';

/** What the contract holds a release to. */
export const RELEASE_LIMITS = Object.freeze({ files: 64, fileBytes: 8 * 1024 * 1024, pathLength: 128, documentBytes: 65_536, release: 2 ** 31 - 1, signaturesRead: 8 });

/** What a signature is made over: this, then the list's text. */
export const RELEASE_SIGNED_PREFIX = 'petcam.release.v1|';

const NAME = /^[A-Za-z0-9._-]+$/;
const PAGE_ADDRESS = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/(?:[A-Za-z0-9._~-]+\/)*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const subtle = globalThis.crypto.subtle;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' };

/** Whether `address` can be a page's: https, a host and a path (the root, or folders), ending in a slash, with nothing after. @param {unknown} address */
export const isPageAddress = (address) => typeof address === 'string' && PAGE_ADDRESS.test(address);

/** Whether `path` is one a list may name: file names of A-Z a-z 0-9 . _ - joined by /, none of them . or .., 128 characters at most. @param {unknown} path */
export const isListedPath = (path) => typeof path === 'string' && path.length <= RELEASE_LIMITS.pathLength && path.split('/').every((name) => NAME.test(name) && name !== '.' && name !== '..');

/**
 * The list's text.
 * @param {{ page: string | null, release: number, entry: string, files: { path: string, sha256: string, bytes: number }[] }} of
 */
export function releaseListText(of) {
    return JSON.stringify({ v: 1, page: of.page, release: of.release, entry: of.entry, files: of.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })) });
}

/** The document a release is served with: the list as text, and its signatures.
 * @param {string} list @param {{ key: string, sig: string }[]} [signatures] */
export function releaseDocument(list, signatures = []) {
    return `${JSON.stringify({ v: 1, list, signatures }, null, 2)}\n`;
}

/**
 * What's wrong with a list a build wrote, by the contract's rules and one
 * of this folder's own (its page is an address, https and ending in a
 * slash): nothing, for one a viewer's app would read.
 * @param {string} text @returns {string[]}
 */
export function problemsWithList(text) {
    let list;
    try {
        list = JSON.parse(text);
    } catch {
        return ["isn't JSON"];
    }
    if (list === null || typeof list !== 'object' || Array.isArray(list)) return ["isn't a list"];
    const problems = [];
    if (list.page === null || list.page === undefined) problems.push('names no page');
    else if (!isPageAddress(list.page)) problems.push("its page isn't an address ending in a slash");
    if (list.v !== 1) problems.push('its v is not 1');
    if (!Number.isInteger(list.release) || list.release < 1 || list.release > RELEASE_LIMITS.release) problems.push('its release is not a whole number from 1 to 2^31 − 1');
    if (!isListedPath(list.entry)) problems.push('its entry is not a file name');
    if (!Array.isArray(list.files) || list.files.length < 1 || list.files.length > RELEASE_LIMITS.files) return [...problems, `it has ${Array.isArray(list.files) ? list.files.length : 'no'} files: 1 to ${RELEASE_LIMITS.files}`];
    const named = new Set();
    for (const file of list.files) {
        if (file === null || typeof file !== 'object' || !isListedPath(file.path)) {
            problems.push('a file has no path a list may name');
            continue;
        }
        if (named.has(file.path)) problems.push(`${file.path} is named twice`);
        named.add(file.path);
        if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) problems.push(`${file.path}: its sha256 is not 64 lowercase hex digits`);
        if (!Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > RELEASE_LIMITS.fileBytes) problems.push(`${file.path}: its length is not a whole number up to 8 MB`);
    }
    if (isListedPath(list.entry) && !named.has(list.entry)) problems.push('its entry is not among its files');
    return problems;
}

// ---- The release keys a repository and the apps carry -------------------------

/**
 * The release keys file (repository/release/keys.json): the public halves
 * of the keys whose signatures a published release may carry, X9.63
 * uncompressed in base64url, as the apps carry them, and the oldest release
 * they take. Throws for anything else: a key that isn't one, a key named
 * twice, an oldest release that isn't a whole number from 1.
 * @param {string} text @returns {{ keys: string[], oldest: number }}
 */
export function readReleaseKeys(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("the release keys file isn't JSON");
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.keys)) throw new Error('the release keys file has no list of keys');
    const oldest = parsed.oldest ?? 1;
    if (!Number.isInteger(oldest) || oldest < 1 || oldest > RELEASE_LIMITS.release) throw new Error("the release keys file's oldest release isn't a whole number from 1");
    const keys = [];
    for (const key of parsed.keys) {
        let bytes;
        try {
            bytes = typeof key === 'string' && /^[A-Za-z0-9_-]+$/.test(key) ? fromB64url(key) : null;
        } catch {
            bytes = null;
        }
        if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) throw new Error(`not a release key (65 bytes, X9.63 uncompressed, base64url): ${String(key).slice(0, 20)}`);
        if (keys.includes(key)) throw new Error('a release key is named twice');
        keys.push(key);
    }
    return { keys, oldest };
}

// ---- Signing, and a signature checked alone --------------------------------

/** What a release's signature is over. @param {string} list the list's text, exactly as served */
export const releaseSignedBytes = (list) => utf8(`${RELEASE_SIGNED_PREFIX}${list}`);

/**
 * ECDSA over P-256 with SHA-256, as a viewer checks it: `signature` is r
 * then s, 64 bytes, and nothing else; `publicKey` X9.63 uncompressed.
 * @param {Uint8Array} publicKey @param {Uint8Array} message @param {Uint8Array} signature
 */
export async function verifyP256(publicKey, message, signature) {
    if (publicKey.length !== 65 || publicKey[0] !== 0x04 || signature.length !== 64) return false;
    try {
        const key = await subtle.importKey('raw', publicKey, ECDSA, false, ['verify']);
        return await subtle.verify(SIGNING, key, signature, message);
    } catch {
        return false;
    }
}

/**
 * A signature for a list, by a key the caller holds as one that signs and
 * can't be read out, with its public half: an entry for `signatures`. The
 * release key itself is kept on one Mac and never comes through here as
 * bytes; this is for a key made for a check, or one handed over by whatever
 * holds the real one.
 * @param {string} list @param {{ privateKey: CryptoKey, publicKey: Uint8Array }} key @returns {Promise<{ key: string, sig: string }>}
 */
export async function signRelease(list, key) {
    // Web Crypto writes an ECDSA signature as r then s, which is the form a release carries.
    const signature = new Uint8Array(await subtle.sign(SIGNING, key.privateKey, releaseSignedBytes(list)));
    return { key: b64url(key.publicKey), sig: b64url(signature) };
}

/** A P-256 signing key that can't be read out, made here and kept nowhere:
 * for a check of what a build writes, never for a release. */
export async function makeCheckKey() {
    const pair = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

// ---- A release as a viewer checks it ---------------------------------------

/** Why a release isn't taken: `code` is `not_a_release` (not a release
 * document, or its list isn't one), `not_signed` (no signature by a key the
 * build carries holds), `another_page` (signed for another address),
 * `too_old` (older than the build takes), `older_than_seen` (older than the
 * newest the device has taken), `file_missing` or `file_changed` (what's
 * served isn't what was signed). */
export class ReleaseError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ReleaseError';
        this.code = code;
    }
}

/** @typedef {{ release: number, page: string, entry: string, files: { path: string, sha256: string, bytes: number }[] }} PageRelease */

/**
 * A release document, checked as a viewer's app checks it before it shows a
 * code, in the contract's order: it is a document; a signature by a key the
 * build carries holds over the prefix and the list's text exactly as it
 * came; the list is one; it is for the build's page, compared whole; it is
 * no older than the build takes, nor than the newest the device has taken.
 * Nothing of the list is read before a signature holds. Throws a
 * `ReleaseError` otherwise.
 * @param {string | Uint8Array} document as it was served
 * @param {{ keys: string[], page: string, minimum: number, newestSeen?: number | null }} how what a build carries (its release keys, X9.63 in base64url; the page's address; the oldest release it takes), and the newest release the device has taken
 * @returns {Promise<PageRelease>}
 */
export async function checkRelease(document, how) {
    const bytes = typeof document === 'string' ? utf8(document) : document;
    if (bytes.length > RELEASE_LIMITS.documentBytes) throw new ReleaseError('not_a_release', 'too long to be a release');
    let outer;
    try {
        outer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new ReleaseError('not_a_release', 'not JSON');
    }
    if (outer === null || typeof outer !== 'object' || Array.isArray(outer) || outer.v !== 1 || typeof outer.list !== 'string' || !Array.isArray(outer.signatures)) {
        throw new ReleaseError('not_a_release', 'not a release document');
    }
    const carried = how.keys.map((key) => b64url(fromB64url(key)));
    const signed = releaseSignedBytes(outer.list);
    let holds = false;
    for (const entry of outer.signatures.slice(0, RELEASE_LIMITS.signaturesRead)) {
        if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string' || typeof entry.sig !== 'string') continue;
        let key;
        let sig;
        try {
            key = b64url(fromB64url(entry.key));
            sig = fromB64url(entry.sig);
        } catch {
            continue;
        }
        // Checked with the build's own copy of the key, never the document's.
        const own = carried.find((candidate) => candidate === key);
        if (own !== undefined && (await verifyP256(fromB64url(own), signed, sig))) {
            holds = true;
            break;
        }
    }
    if (!holds) throw new ReleaseError('not_signed', 'no signature by a key this build carries holds');

    let list;
    try {
        list = JSON.parse(outer.list);
    } catch {
        throw new ReleaseError('not_a_release', 'the list is not JSON');
    }
    if (list === null || typeof list !== 'object' || Array.isArray(list) || list.v !== 1 || typeof list.page !== 'string' || typeof list.entry !== 'string'
        || !Number.isInteger(list.release) || list.release < 1 || list.release > RELEASE_LIMITS.release
        || !Array.isArray(list.files) || list.files.length < 1 || list.files.length > RELEASE_LIMITS.files) {
        throw new ReleaseError('not_a_release', 'not a release list');
    }
    const files = [];
    const seen = new Set();
    for (const file of list.files) {
        if (file === null || typeof file !== 'object' || !isListedPath(file.path) || typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)
            || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > RELEASE_LIMITS.fileBytes || seen.has(file.path)) {
            throw new ReleaseError('not_a_release', 'a file the list names twice, or not as a path, a SHA-256 in hex and a length');
        }
        seen.add(file.path);
        files.push({ path: file.path, sha256: file.sha256, bytes: file.bytes });
    }
    if (!seen.has(list.entry)) throw new ReleaseError('not_a_release', "the page's own file isn't among its files");
    if (list.page !== how.page) throw new ReleaseError('another_page', 'signed for another address');
    if (list.release < how.minimum) throw new ReleaseError('too_old', 'older than this build takes');
    if (how.newestSeen !== undefined && how.newestSeen !== null && list.release < how.newestSeen) throw new ReleaseError('older_than_seen', 'older than the newest this device has taken');
    return { release: list.release, page: list.page, entry: list.entry, files };
}

/**
 * Whether what a host serves is the release: the page's address itself
 * serves the entry file, and every listed path its file, each the length
 * and the SHA-256 the list says. Throws a `ReleaseError` otherwise.
 * @param {PageRelease} release
 * @param {{ address: Uint8Array | null, files: Record<string, Uint8Array | null | undefined> }} served what came back from the page's address, and from each path under it (null: nothing did)
 */
export async function checkServed(release, served) {
    /** @param {Uint8Array | null | undefined} body @param {{ path: string, sha256: string, bytes: number }} file @param {string} where */
    const same = async (body, file, where) => {
        if (body === null || body === undefined) throw new ReleaseError('file_missing', `${where} wasn't served`);
        const hash = Array.from(new Uint8Array(await subtle.digest('SHA-256', body)), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (body.length !== file.bytes || hash !== file.sha256) throw new ReleaseError('file_changed', `${where} isn't the file that was signed`);
    };
    const entry = /** @type {{ path: string, sha256: string, bytes: number }} */ (release.files.find((file) => file.path === release.entry));
    await same(served.address, entry, "the page's address");
    for (const file of release.files) await same(served.files[file.path], file, file.path);
}
