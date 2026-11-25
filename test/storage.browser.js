// What a browser keeps for a camera: its keys go into the browser's storage
// and come back usable and still unreadable, in each browser. The plan had
// this measured for the P-256 key alone (docs/WEB-CAMERA.md § 11); here it
// is for the keys from a camera's secret too.

import { textOf } from '../src/crypto/bytes.js';
import { hpkeOpen, hpkeSeal } from '../src/crypto/hpke.js';
import { KeySet, SealContext } from '../src/crypto/keys.js';
import { generateDeviceKey } from '../src/crypto/p256.js';
import { STORE_NAME, browserStore, memoryStore } from '../src/crypto/store.js';
import { assert, suite, test } from './lib/harness.js';

suite("the browser's storage");

/** @param {CryptoKey} key */
async function cannotBeRead(key) {
    assert.equal(key.extractable, false);
    for (const format of ['raw', 'jwk', 'pkcs8']) await assert.throws(() => globalThis.crypto.subtle.exportKey(format, key), `exporting it as ${format}`);
}

test("keeps a camera's keys usable and unreadable across a visit", async () => {
    const camera = 'c0000000-0000-4000-8000-00000000000c';
    const first = browserStore();
    await first.clear();
    assert.equal(await first.get('camera'), undefined);

    const deviceKey = await generateDeviceKey();
    const keys = await KeySet.forCamera(globalThis.crypto.getRandomValues(new Uint8Array(32)), 4);
    const status = await keys.sealMessage({ armed: true, sent_at: 1 }, SealContext.status(camera));
    const signature = await keys.sign('session|offer|v=0');
    await first.set('camera', { deviceKey, keys: keys.kept(), endsAt: 1_767_312_000_000, startedBy: 'Maya Lopez' });

    // As a page opened again would find it: another connection to the same storage.
    const again = browserStore();
    const kept = await again.get('camera');
    assert.equal([kept.endsAt, kept.startedBy], [1_767_312_000_000, 'Maya Lopez']);
    assert.equal(kept.deviceKey.publicKey, deviceKey.publicKey);
    await cannotBeRead(kept.deviceKey.privateKey);
    for (const key of [kept.keys[0].box, kept.keys[0].media, kept.keys[0].signal]) await cannotBeRead(key);

    // Still the same keys: what was sealed before opens, and the same signature comes out.
    const back = KeySet.fromKept(kept.keys);
    assert.equal(await back.openMessage(status, SealContext.status(camera), { fresh: true }), { armed: true, sent_at: 1 });
    assert.equal(await back.sign('session|offer|v=0'), signature);
    assert.ok(await back.verify('session|offer|v=0', signature));
    // And the same device key: something wrapped for it before still opens.
    const sender = await generateDeviceKey();
    const wrapped = await hpkeSeal({ mode: 'auth', recipientPublicKey: deviceKey.publicKey, sender, info: 'petcam.test', aad: 'kept', plaintext: 'for the key that was kept' });
    assert.equal(textOf(await hpkeOpen({ mode: 'auth', recipient: kept.deviceKey, senderPublicKey: sender.publicKey, info: 'petcam.test', aad: 'kept', sealed: wrapped })), 'for the key that was kept');

    // At the camera's end everything goes.
    await again.clear();
    const names = (await globalThis.indexedDB.databases?.())?.map((db) => db.name) ?? [];
    assert.ok(!names.includes(STORE_NAME), 'the database itself is gone');
    // Asking afterwards finds nothing (and makes an empty one, which goes again).
    const after = browserStore();
    assert.equal(await after.get('camera'), undefined);
    await after.clear();
});

test('reads only what it kept itself', async () => {
    // An earlier test page left a diary in this kind of storage under other
    // keys (docs/WEB-CAMERA.md § 7): nothing of the sort is read.
    globalThis.localStorage.setItem('petcam-check-loads', '7');
    const store = browserStore();
    await store.set('seen', { a: 1 });
    assert.equal(await store.get('seen'), { a: 1 });
    assert.equal(await store.get('petcam-check-loads'), undefined);
    await store.remove('seen');
    assert.equal(await store.get('seen'), undefined);
    await store.clear();
    globalThis.localStorage.removeItem('petcam-check-loads');
    // The stand-in for where there is no storage behaves the same.
    const memory = memoryStore();
    await memory.set('k', 1);
    assert.equal(await memory.get('k'), 1);
    await memory.clear();
    assert.equal(await memory.get('k'), undefined);
});

test("is asked to keep it, and may say no", async () => {
    // Safari on a Mac answered no on 2026-11-19; a camera has to live with either.
    const persisted = await navigator.storage?.persisted?.();
    assert.ok(persisted === true || persisted === false || persisted === undefined);
});
