// What the public repository's workflow runs before it publishes the page
// (.github/workflows/publish.yml there; repository/ here):
//
//   node tools/publish-check.mjs [--dist dist] [--release release/release.json] [--keys release/keys.json] [--live <address>]
//
// It holds a fresh build to the release document signed on the release
// key's Mac and committed beside it, and passes only if:
//
// 1. the release keys file names at least one key (until the real key is
//    made, nothing can be published);
// 2. the document is one the apps take: signed by one of those keys, for the
//    page's own address (src/config.js, PAGE), no older than they take;
// 3. its list is, byte for byte, the list this build wrote: the same source
//    gives the same bytes, so a signed list stands for exactly one source;
// 4. every file the list names is in the build with its length and SHA-256,
//    the page's own file among them, and the build has no other file;
// 5. with --live, it is no older than the release the page's address serves
//    now, if it serves one (an older one would be refused by every device
//    that has taken the newer), and the same number only for the same list.
//
// Then it puts the signed document in the build's place (dist/release.json),
// and the build is what gets published. Anything else: it says why, exits 1,
// and nothing is published. It never signs anything and holds no key.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE } from '../src/config.js';
import { ReleaseError, checkRelease, checkServed, readReleaseKeys } from './release.mjs';
import { filesIn } from './verify-build.mjs';

/** Why the build isn't published. */
export class NotPublishable extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'NotPublishable';
    }
}

/**
 * The release the page's address serves now, or null where it serves none
 * that reads (nothing there yet, or not a release these keys signed).
 * @param {string} address @param {{ keys: string[], oldest: number }} known @param {typeof fetch} fetchFn
 */
async function liveRelease(address, known, fetchFn) {
    let body;
    try {
        const answer = await fetchFn(`${address}release.json`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (!answer.ok) return null;
        body = new Uint8Array(await answer.arrayBuffer());
    } catch {
        return null;
    }
    try {
        const release = await checkRelease(body, { keys: known.keys, page: address, minimum: 1 });
        return { release: release.release, list: JSON.parse(new TextDecoder().decode(body)).list };
    } catch {
        return null;
    }
}

/**
 * @param {{ dist: string, release: string, keys: string, live?: string | null, page?: string, fetch?: typeof fetch }} how
 * @returns {Promise<{ release: number, files: number, live: number | null, notes: string[] }>}
 */
export async function checkPublishable(how) {
    const page = how.page ?? PAGE;
    const notes = [];
    let known;
    try {
        known = readReleaseKeys(readFileSync(how.keys, 'utf8'));
    } catch (error) {
        throw new NotPublishable(`The release keys (${how.keys}) don't read: ${error.message}.`);
    }
    if (known.keys.length === 0) throw new NotPublishable(`No release key yet (${how.keys} lists none): nothing is published until one is made and a release is signed with it.`);

    let documentBytes;
    try {
        documentBytes = readFileSync(how.release);
    } catch {
        throw new NotPublishable(`No signed release document (${how.release}): sign one on the release key's Mac (node tools/sign-release.mjs).`);
    }
    let release;
    try {
        release = await checkRelease(documentBytes, { keys: known.keys, page, minimum: known.oldest });
    } catch (error) {
        if (error instanceof ReleaseError) throw new NotPublishable(`The signed release isn't one the apps take: ${error.code} (${error.message}).`);
        throw error;
    }
    const signedList = JSON.parse(documentBytes.toString('utf8')).list;

    const built = filesIn(how.dist);
    const builtDocument = built.get('release.json');
    if (!builtDocument) throw new NotPublishable(`The build (${how.dist}) has no release.json: build it with node tools/build.mjs.`);
    const builtList = JSON.parse(builtDocument.toString('utf8')).list;
    if (builtList !== signedList) throw new NotPublishable("The signed list isn't the list this build wrote: the source isn't the one that was signed, or it was built differently. Sign this source's release again on the release key's Mac.");

    try {
        await checkServed(release, { address: built.get(release.entry) ?? null, files: Object.fromEntries(built) });
    } catch (error) {
        if (error instanceof ReleaseError) throw new NotPublishable(`The build isn't what the signed list says: ${error.message}.`);
        throw error;
    }
    const extra = [...built.keys()].filter((name) => name !== 'release.json' && !release.files.some((file) => file.path === name));
    if (extra.length > 0) throw new NotPublishable(`The build has files the signed list doesn't: ${extra.join(', ')}.`);

    let live = null;
    if (how.live) {
        const now = await liveRelease(how.live, known, how.fetch ?? fetch);
        if (now === null) notes.push(`${how.live} serves no release these keys signed yet.`);
        else {
            live = now.release;
            if (release.release < now.release) throw new NotPublishable(`Release ${release.release} is older than release ${now.release}, which ${how.live} serves now: every device that has taken that one would refuse this.`);
            if (release.release === now.release && now.list !== signedList) throw new NotPublishable(`Release ${release.release} is already served with other files: a change takes a higher release number.`);
            if (release.release === now.release) notes.push(`Release ${release.release} is the one served now: publishing it again changes nothing.`);
        }
    }
    writeFileSync(path.join(how.dist, 'release.json'), documentBytes);
    return { release: release.release, files: release.files.length, live, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
        const at = args.indexOf(`--${name}`);
        return at >= 0 ? args[at + 1] : fallback;
    };
    try {
        const done = await checkPublishable({ dist: option('dist', 'dist'), release: option('release', 'release/release.json'), keys: option('keys', 'release/keys.json'), live: option('live', null) });
        for (const note of done.notes) console.log(note);
        console.log(`Release ${done.release} for ${PAGE}: the signed list is this build's, its ${done.files} files are the build's, and the signed document is in its place. Ready to publish.`);
    } catch (error) {
        console.error(error instanceof NotPublishable ? `Not published. ${error.message}` : `Not published: ${error?.stack ?? error}`);
        process.exitCode = 1;
    }
}
