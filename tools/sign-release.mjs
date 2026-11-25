// Signs a release of the camera page, on the Mac that holds the release key:
//
//   node tools/sign-release.mjs [--key <file>] [--keys <file>] [--out <file>]
//
// 1. Builds the page into dist/, from the source as it is (tools/build.mjs).
// 2. Refuses a release number that's already signed for other files: each
//    release has one list, so a change takes a higher RELEASE in
//    src/config.js.
// 3. Signs the list with the release key (tools/release-key.mjs), which asks
//    for Touch ID or this Mac's password.
// 4. Keeps any other key's signature over the same list (a second key
//    signing the same release), and writes the release document.
// 5. Checks the document as the apps check one (signed by a key they carry,
//    for the page's own address, no older than they take), and the build
//    against it, file by file.
// 6. Only then writes it, by default to repository/release/release.json,
//    beside the release keys (repository/release/keys.json). The public
//    repository's workflow publishes the page only with that document, and
//    only if a fresh build of the same source is exactly what it lists.
//
// Nothing here talks to a network, and the key never leaves the Secure
// Enclave: only the list's text goes in, and only the signature comes out.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
import { signList } from './release-key.mjs';
import { ReleaseError, checkRelease, checkServed, readReleaseKeys, releaseDocument } from './release.mjs';
import { filesIn } from './verify-build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Where the release keys and the signed release are: repository/release/ in the app repository's copy of the page, release/ in its public repository. */
const RELEASE_FOLDER = existsSync(path.join(root, 'repository', 'release')) ? path.join(root, 'repository', 'release') : path.join(root, 'release');
export const DEFAULT_KEYS = path.join(RELEASE_FOLDER, 'keys.json');
export const DEFAULT_OUT = path.join(RELEASE_FOLDER, 'release.json');

/** Why a release wasn't signed, or wasn't written. */
export class SignError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'SignError';
    }
}

/**
 * Builds, signs, checks and writes a release document.
 * @param {{ key?: string | null, keys?: string, out?: string, dist?: string, sign?: (list: string, how: { key?: string | null, reason?: string }) => Promise<{ key: string, sig: string }> }} [how] `sign` stands in for the release key in a test
 * @returns {Promise<{ release: number, page: string, files: number, key: string, out: string, signatures: number }>}
 */
export async function signRelease(how = {}) {
    const keysFile = how.keys ?? DEFAULT_KEYS;
    const out = how.out ?? DEFAULT_OUT;
    const known = readReleaseKeys(readFileSync(keysFile, 'utf8'));
    const built = await build(how.dist ?? path.join(root, 'dist'));
    const list = built.list;

    // One list a release: a release number already signed for other files is never signed again.
    let kept = [];
    if (existsSync(out)) {
        const before = JSON.parse(readFileSync(out, 'utf8'));
        const listed = typeof before?.list === 'string' ? JSON.parse(before.list) : null;
        if (before.list === list) kept = Array.isArray(before.signatures) ? before.signatures : [];
        else if (listed?.release === built.release) {
            throw new SignError(`Release ${built.release} is already signed for other files (${path.relative(process.cwd(), out)}). Raise RELEASE in src/config.js for these: nothing was signed.`);
        } else if (Number.isInteger(listed?.release) && listed.release > built.release) {
            throw new SignError(`${path.relative(process.cwd(), out)} holds release ${listed.release}, newer than this build's ${built.release}: the apps would refuse an older one. Nothing was signed.`);
        }
    }

    const signature = await (how.sign ?? signList)(list, { key: how.key ?? null, reason: `sign release ${built.release} of the camera page` });
    const signatures = [...kept.filter((entry) => entry?.key !== signature.key), signature];
    const document = releaseDocument(list, signatures);

    // As the apps check it, and the build against it, before anything is written.
    let release;
    try {
        release = await checkRelease(document, { keys: known.keys, page: built.page, minimum: known.oldest });
    } catch (error) {
        if (!(error instanceof ReleaseError)) throw error;
        if (error.code === 'not_signed') {
            throw new SignError(`Signed, but by a key the apps don't carry: ${signature.key}. Put it in ${path.relative(process.cwd(), keysFile)} and in the apps' release keys first. Nothing was written.`);
        }
        throw new SignError(`The signed release isn't one the apps would take (${error.code}: ${error.message}). Nothing was written.`);
    }
    const files = Object.fromEntries(filesIn(built.out));
    await checkServed(release, { address: files[release.entry] ?? null, files });
    writeFileSync(out, document);
    return { release: release.release, page: release.page, files: release.files.length, key: signature.key, out, signatures: signatures.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name) => {
        const at = args.indexOf(`--${name}`);
        return at >= 0 ? args[at + 1] : undefined;
    };
    try {
        const signed = await signRelease({ key: option('key') ?? null, keys: option('keys') ? path.resolve(option('keys')) : undefined, out: option('out') ? path.resolve(option('out')) : undefined });
        console.log(`Signed release ${signed.release} of the camera page, for ${signed.page}: ${signed.files} files, by ${signed.key}.`);
        console.log(`Checked as the apps check one, and the build against it. Written to ${path.relative(process.cwd(), signed.out)}${signed.signatures > 1 ? `, with ${signed.signatures} signatures` : ''}.`);
        console.log('Next: commit it, and put the page into its public repository (node tools/export-repository.mjs <checkout>), where the workflow publishes it.');
    } catch (error) {
        console.error(error instanceof SignError || error?.name === 'KeyToolError' ? error.message : `Not signed: ${error?.stack ?? error}`);
        process.exitCode = Number.isInteger(error?.code) ? error.code : 1;
    }
}
