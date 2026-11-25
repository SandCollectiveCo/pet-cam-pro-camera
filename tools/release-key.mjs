// The release key, from Node: tools/release-key.swift compiled into a
// folder of the system's temporary files, run, and the folder deleted, so
// nothing of it is left but the key itself.
//
//   node tools/release-key.mjs make     makes the key in this Mac's Secure Enclave (once), and prints its public half
//   node tools/release-key.mjs public   prints the public half again
//
// Both take --key <file> for a key somewhere else than its usual place
// (~/Library/Application Support/PetCamPro/camera-page-release.key), and
// `make` takes --no-presence, for a test's throwaway key alone. Signing a
// release is tools/sign-release.mjs, which uses `sign` from here.
//
// macOS only, with Xcode's Swift: the Secure Enclave is the point.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'release-key.swift');

/** Why the key tool said no: its own words, and its exit code (2 how it was asked, 3 a key already there, 4 said no to). */
export class KeyToolError extends Error {
    /** @param {string} message @param {number} code */
    constructor(message, code) {
        super(message);
        this.name = 'KeyToolError';
        this.code = code;
    }
}

/**
 * Compiles the tool and runs `work` with a way to run it; the compiled tool
 * goes when `work` is done, whatever happened.
 * @template T @param {(run: (args: string[], input?: string) => any) => Promise<T> | T} work
 * @returns {Promise<T>}
 */
export async function withKeyTool(work) {
    if (process.platform !== 'darwin') throw new KeyToolError('The release key is made and used on a Mac: its Secure Enclave holds it.', 2);
    const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-release-key-'));
    try {
        const tool = path.join(folder, 'release-key');
        try {
            execFileSync('xcrun', ['swiftc', '-O', '-o', tool, SOURCE], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (error) {
            throw new KeyToolError(`Couldn't compile tools/release-key.swift (Xcode's command line tools are needed): ${String(error.stderr ?? error.message).trim()}`, 1);
        }
        /** @param {string[]} args @param {string} [input] */
        const run = (args, input) => {
            const done = spawnSync(tool, args, { input: input ?? '', encoding: 'utf8', maxBuffer: 1024 * 1024 });
            if (done.error) throw new KeyToolError(`The key tool didn't run: ${done.error.message}`, 1);
            if (done.status !== 0) throw new KeyToolError(done.stderr.trim() || `The key tool stopped with ${done.status}.`, done.status ?? 1);
            return JSON.parse(done.stdout);
        };
        return await work(run);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}

/** @param {{ key?: string | null }} how */
const keyArgs = (how) => (how.key ? ['--key', how.key] : []);

/** Makes the key, once. @param {{ key?: string | null, presence?: boolean }} [how] @returns {Promise<{ public_key: string, path: string, presence: boolean }>} */
export const makeKey = (how = {}) => withKeyTool((run) => run(['make', ...keyArgs(how), ...(how.presence === false ? ['--no-presence'] : [])]));

/** The key's public half. @param {{ key?: string | null }} [how] @returns {Promise<{ public_key: string, path: string }>} */
export const publicKey = (how = {}) => withKeyTool((run) => run(['public', ...keyArgs(how)]));

/**
 * A signature over "petcam.release.v1|" and `list`, exactly, by the key: the
 * entry a release document carries. Asks for Touch ID or the password where
 * the key was made to.
 * @param {string} list the list's text @param {{ key?: string | null, reason?: string }} [how]
 * @returns {Promise<{ key: string, sig: string }>}
 */
export const signList = (list, how = {}) => withKeyTool((run) => run(['sign', ...keyArgs(how), ...(how.reason ? ['--reason', how.reason] : [])], list));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, ...rest] = process.argv.slice(2);
    const at = rest.indexOf('--key');
    const key = at >= 0 ? rest[at + 1] : null;
    try {
        if (command === 'make') {
            const made = await makeKey({ key, presence: !rest.includes('--no-presence') });
            console.log("Made the camera page's release key in this Mac's Secure Enclave. Its private half can't leave it.");
            console.log(`Kept at: ${made.path} (the Secure Enclave's own handle for it: it opens on this Mac alone, and only while this Mac is as it is now)`);
            console.log(made.presence ? 'Each signature asks for Touch ID or this Mac’s password.' : 'It signs without asking: a test’s key.');
            console.log('\nIts public half, the release key the apps and the page’s repository carry:\n');
            console.log(`  ${made.public_key}\n`);
            console.log('It goes, as one entry of each list:');
            console.log(`  the Apple apps     CameraPageBuild.releaseKeys = ["${made.public_key}"]`);
            console.log('  Android            the same text, in the list of release keys its page check carries');
            console.log(`  the page           repository/release/keys.json, "keys": ["${made.public_key}"]`);
            console.log('\nIf this Mac is lost or erased, so is this key: make a second one on another Mac the same way, and carry both.');
        } else if (command === 'public') {
            const known = await publicKey({ key });
            console.log(known.public_key);
        } else {
            console.error('Usage: node tools/release-key.mjs make|public [--key <file>]');
            process.exitCode = 2;
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = error.code ?? 1;
    }
}
