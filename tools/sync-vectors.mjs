// The test vectors this page is held to are the apps' own: docs/vectors/ in
// the apps' repository, made there by server/scripts/vectors.mjs and never
// edited by hand. This folder has to build and test by itself, so it keeps
// byte-for-byte copies of the files it implements something from.
//
//   node tools/sync-vectors.mjs          copy them in again
//   node tools/sync-vectors.mjs --check  fail if a copy differs
//
// Outside the apps' repository there is nothing to compare with, and both
// say so and change nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The files something here is held to: the six the apps' own cameras are
 * held to, and the two the contract pins for a temporary camera and for the
 * page's releases. accounts-v1 (signing in) and alerts-v1 (pushes) are for
 * devices that sign in and get alerts: a temporary camera does neither. */
export const VECTOR_FILES = ['keys-v1', 'sealed-v1', 'keyring-v1', 'invite-v1', 'wire-v1', 'realtime-v1', 'temporary-camera-v1', 'page-release-v1'];

const here = path.dirname(fileURLToPath(import.meta.url));
const copies = path.join(here, '..', 'vectors');
const source = path.join(here, '..', '..', 'docs', 'vectors');

/** The names of the copies that differ from the apps' files; null when the
 * apps' files aren't there to compare with. @returns {string[] | null} */
export function differing() {
    if (!existsSync(source)) return null;
    return VECTOR_FILES.filter((name) => {
        const copy = path.join(copies, `${name}.json`);
        return !existsSync(copy) || !readFileSync(copy).equals(readFileSync(path.join(source, `${name}.json`)));
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const changed = differing();
    if (changed === null) {
        console.log("docs/vectors/ isn't beside this folder: nothing to compare the copies with.");
    } else if (process.argv.includes('--check')) {
        if (changed.length > 0) {
            console.error(`These copies differ from docs/vectors/: ${changed.join(', ')}. Run node tools/sync-vectors.mjs.`);
            process.exit(1);
        }
        console.log(`The ${VECTOR_FILES.length} copies are docs/vectors/'s, byte for byte.`);
    } else {
        for (const name of changed) writeFileSync(path.join(copies, `${name}.json`), readFileSync(path.join(source, `${name}.json`)));
        console.log(changed.length > 0 ? `Copied ${changed.join(', ')}.` : 'Nothing to copy: every copy is current.');
    }
}
