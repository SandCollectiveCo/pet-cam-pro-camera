// The release key tool, for real, with throwaway keys (on a Mac):
//
//   node test/run-release-key.mjs
//
// Each key is made in this Mac's Secure Enclave without the Touch ID check
// (--no-presence), kept in a temporary folder, and gone with it: the
// Secure Enclave keeps nothing of a key whose handle is deleted, nothing
// goes into any keychain, and the release key's usual place is looked at
// before and after, and never touched. The compiled tool is deleted after
// each use (tools/release-key.mjs).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE } from '../src/config.js';
import { KeyToolError, makeKey, publicKey, signList } from '../tools/release-key.mjs';
import { checkRelease, releaseSignedBytes, verifyP256 } from '../tools/release.mjs';
import { signRelease } from '../tools/sign-release.mjs';
import { assert, runAll, suite, test } from './lib/harness.js';

if (process.platform !== 'darwin') {
    console.log('· The release key is a Mac’s: these tests run on one.');
    process.exit(0);
}

const usual = path.join(os.homedir(), 'Library', 'Application Support', 'PetCamPro', 'camera-page-release.key');
const stateOf = (file) => (existsSync(file) ? (({ size, mtimeMs, ino }) => ({ size, mtimeMs, ino }))(statSync(file)) : null);
const usualBefore = stateOf(usual);
const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-release-key-test-'));
const leftBefore = readdirSync(os.tmpdir()).filter((name) => name.startsWith('petcam-release-key-') && !name.startsWith('petcam-release-key-test-')).length;

/** What the tool refused with. @param {() => Promise<unknown>} fn */
async function refusal(fn) {
    const error = await assert.throws(fn);
    assert.ok(error instanceof KeyToolError, String(error));
    return error;
}

suite('the release key');

test('is made once in the Secure Enclave, kept as its handle, and never made again over itself', async () => {
    const key = path.join(folder, 'one', 'release.key');
    const made = await makeKey({ key, presence: false });
    const half = Buffer.from(made.public_key, 'base64url');
    assert.equal([half.length, half[0], made.path, made.presence], [65, 0x04, key, false]);
    assert.equal(statSync(key).mode & 0o777, 0o600, 'readable by its owner alone');
    assert.equal(statSync(path.dirname(key)).mode & 0o777, 0o700);
    const handle = readFileSync(key);
    // The Secure Enclave's own wrapped handle (with the public half in it, which is no secret): only this Mac's Enclave opens it.
    assert.ok(handle.length > 100, 'a handle');
    const again = await refusal(() => makeKey({ key, presence: false }));
    assert.equal(again.code, 3);
    assert.ok(again.message.includes(made.public_key), again.message);
    assert.equal(readFileSync(key), handle, 'the key that was there is still there');
    assert.equal((await publicKey({ key })).public_key, made.public_key);
});

test('signs a list as a release carries it: P-256 over the prefix and the text, r then s', async () => {
    const key = path.join(folder, 'two', 'release.key');
    const made = await makeKey({ key, presence: false });
    const half = Buffer.from(made.public_key, 'base64url');
    const list = JSON.stringify({ v: 1, page: 'https://camera.petcampro.com/', release: 7, entry: 'index.html', files: [{ path: 'index.html', sha256: '0'.repeat(64), bytes: 1 }] });
    const first = await signList(list, { key, reason: 'a test' });
    const second = await signList(list, { key });
    assert.equal([first.key, Buffer.from(first.sig, 'base64url').length], [made.public_key, 64]);
    assert.ok(await verifyP256(half, releaseSignedBytes(list), Buffer.from(first.sig, 'base64url')), 'the first holds');
    assert.ok(await verifyP256(half, releaseSignedBytes(list), Buffer.from(second.sig, 'base64url')), 'and the second, though ECDSA never signs the same way twice');
    assert.notEqual(first.sig, second.sig);
    assert.ok(!(await verifyP256(half, releaseSignedBytes(`${list} `), Buffer.from(first.sig, 'base64url'))), 'over one more space, it doesn’t');
    // What it won't sign with, or won't sign.
    assert.equal((await refusal(() => signList(list, { key: path.join(folder, 'none.key') }))).code, 1);
    writeFileSync(path.join(folder, 'garbage.key'), Buffer.alloc(324, 7));
    assert.ok(/doesn't open in this Mac's Secure Enclave/.test((await refusal(() => signList(list, { key: path.join(folder, 'garbage.key') }))).message));
    assert.equal((await refusal(() => signList('', { key }))).code, 2);
});

test('signs the page’s own release, checked as the apps check one', async () => {
    const key = path.join(folder, 'three', 'release.key');
    const made = await makeKey({ key, presence: false });
    const keys = path.join(folder, 'keys.json');
    writeFileSync(keys, JSON.stringify({ keys: [made.public_key], oldest: 1 }));
    const out = path.join(folder, 'release.json');
    const signed = await signRelease({ key, keys, out, dist: path.join(folder, 'dist') });
    assert.equal([signed.release, signed.key], [RELEASE, made.public_key]);
    const release = await checkRelease(readFileSync(out), { keys: [made.public_key], page: signed.page, minimum: 1 });
    assert.equal(release.files.length, signed.files);
});

const results = await runAll({ each: (r) => console.log(r.ok ? `✓ ${r.name} (${r.ms} ms)` : `✗ ${r.name}\n    ${String(r.error).split('\n').join('\n    ')}`) });
rmSync(folder, { recursive: true, force: true });
const leftAfter = readdirSync(os.tmpdir()).filter((name) => name.startsWith('petcam-release-key-') && !name.startsWith('petcam-release-key-test-')).length;
const untouched = JSON.stringify(stateOf(usual)) === JSON.stringify(usualBefore);
console.log(untouched ? `✓ the release key's usual place is as it was (${usualBefore ? 'a key is there' : 'nothing there'})` : "✗ the release key's usual place changed");
console.log(leftAfter === leftBefore && !existsSync(folder) ? '✓ nothing left behind: no throwaway key, no compiled tool' : '✗ something was left behind');
const failed = results.filter((r) => !r.ok).length + (untouched ? 0 : 1) + (leftAfter === leftBefore ? 0 : 1);
console.log(`\n${results.length - results.filter((r) => !r.ok).length} of ${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
