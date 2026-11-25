// HPKE on the browser's own crypto against the CFRG's vectors for the suite
// and the keyrings in docs/vectors/keyring-v1.json, CryptoKit's among them.
// A page never opens a home's keyring: these are a made-up home's, and what
// is held here is that anything wrapped as one is wrapped opens only for
// the device, sender, household and epoch it was wrapped for.

import { b64url, fromB64url, fromHex, hex, textOf, utf8 } from '../src/crypto/bytes.js';
import { KEYRING_INFO, hpkeOpen, hpkeRecipient, hpkeSeal, hpkeSender, keyringAad } from '../src/crypto/hpke.js';
import { dh, generateDeviceKey, looksLikePublicKey } from '../src/crypto/p256.js';
import { assert, suite, test, vectors } from './lib/harness.js';
import { deviceKey, deviceKeyFromHex, outcome } from './lib/keys.js';

suite('keyring-v1');

test("reproduce the CFRG's HPKE vectors for the suite, in base and auth mode", async () => {
    const file = await vectors('keyring-v1');
    assert.equal(file.hpke_cfrg.vectors.map((v) => v.mode), [0, 2]);
    for (const v of file.hpke_cfrg.vectors) {
        assert.equal([v.kem_id, v.kdf_id, v.aead_id], [16, 1, 2]);
        const mode = v.mode === 2 ? 'auth' : 'base';
        const sender = await hpkeSender({
            mode, recipientPublicKey: fromHex(v.pkRm), sender: v.skSm ? await deviceKeyFromHex(v.skSm, v.pkSm) : undefined,
            ephemeral: await deviceKeyFromHex(v.skEm, v.pkEm), info: fromHex(v.info),
        });
        const recipient = await hpkeRecipient({
            mode, recipient: await deviceKeyFromHex(v.skRm, v.pkRm), senderPublicKey: v.pkSm ? fromHex(v.pkSm) : undefined, enc: fromHex(v.enc), info: fromHex(v.info),
        });
        assert.equal(hex(sender.enc), v.enc);
        assert.equal(v.enc, v.pkEm);
        for (const side of [sender, recipient]) {
            assert.equal(hex(side.sharedSecret), v.shared_secret, `mode ${v.mode}: shared secret`);
            assert.equal(hex(side.keyScheduleContext), v.key_schedule_context);
            assert.equal(hex(side.secret), v.secret);
            assert.equal(hex(side.key), v.key);
            assert.equal(hex(side.baseNonce), v.base_nonce);
            assert.equal(hex(side.exporterSecret), v.exporter_secret);
        }
        assert.equal(v.encryptions.map((e) => e.sequence), [0, 1, 2, 4, 255, 256]);
        for (const e of v.encryptions) {
            assert.equal(hex(await sender.seal(fromHex(e.pt), fromHex(e.aad), e.sequence)), e.ct, `mode ${v.mode}, sequence ${e.sequence}`);
            assert.equal(hex(await recipient.open(fromHex(e.ct), fromHex(e.aad), e.sequence)), e.pt);
        }
        assert.equal((await outcome(() => recipient.open(fromHex(v.encryptions[0].ct), fromHex(v.encryptions[1].aad), 0))).expect, 'refused');
    }
});

/** The file's devices as keys the browser holds. @param {any} file */
async function devicesOf(file) {
    const out = {};
    for (const [who, d] of Object.entries(file.devices)) out[who] = { ...d, key: await deviceKey(d.private_key, d.public_key), publicKey: fromB64url(d.public_key) };
    return out;
}

/** Opens a wrapped keyring as the bytes inside, with any one thing changed. */
function unwrap(devices, entry, change = {}) {
    return hpkeOpen({
        mode: 'auth', recipient: change.recipientKey ?? devices[entry.to].key, senderPublicKey: change.senderPublicKey ?? devices.member.publicKey, info: KEYRING_INFO,
        aad: keyringAad(change.householdId ?? entry.household_id, change.recipient ?? entry.recipient, change.epoch ?? entry.epoch), sealed: entry.wrapped,
    });
}

test('wrap a keyring to the same bytes, given the ephemeral key, and open it', async () => {
    const file = await vectors('keyring-v1');
    const devices = await devicesOf(file);
    assert.equal(file.info, KEYRING_INFO);
    for (const entry of file.sealed_by_script) {
        const plaintext = file.plaintexts[entry.plaintext].text;
        // The ephemeral key's public half is the encapsulated key the vector records.
        const ephemeral = await deviceKey(entry.ephemeral_private_key, entry.wrapped.split('.')[0]);
        const again = await hpkeSeal({
            mode: 'auth', recipientPublicKey: devices[entry.to].publicKey, sender: devices.member.key, ephemeral,
            info: KEYRING_INFO, aad: keyringAad(entry.household_id, entry.recipient, entry.epoch), plaintext,
        });
        assert.equal(again, entry.wrapped, entry.name);
        assert.equal(keyringAad(entry.household_id, entry.recipient, entry.epoch), entry.aad, entry.name);
        assert.equal(textOf(await unwrap(devices, entry)), plaintext, entry.name);
    }
    assert.equal(file.associated_data.device, file.sealed_by_script[0].aad);
    assert.equal(file.sealed_by_script.find((entry) => entry.to === 'watch').aad, file.associated_data.watch);
});

test('open the keyrings CryptoKit sealed', async () => {
    const file = await vectors('keyring-v1');
    const devices = await devicesOf(file);
    assert.equal(file.sealed_by_cryptokit.map((entry) => entry.name).sort(), ['approval', 'key_change', 'key_change_off_icloud', 'watch']);
    for (const entry of file.sealed_by_cryptokit) assert.equal(textOf(await unwrap(devices, entry)), entry.plaintext_as_swift_wrote_it, entry.name);
});

test('open a keyring only from its sender, for its recipient, household and epoch', async () => {
    const file = await vectors('keyring-v1');
    const devices = await devicesOf(file);
    let refused = 0;
    for (const entry of [...file.sealed_by_script, ...file.sealed_by_cryptokit]) {
        for (const not of file.must_refuse.changes) {
            const watch = entry.recipient === 'watch';
            const change =
                not.change === 'sender' ? { senderPublicKey: devices[not.to].publicKey }
                    : not.change === 'recipient_key' ? { recipientKey: devices[not.to].key }
                        : not.change === 'recipient' ? { recipient: not.to === 'watch_or_device' ? (watch ? devices.newcomer.device_id : 'watch') : not.to }
                            : not.change === 'household_id' ? { householdId: not.to }
                                : { epoch: entry.epoch + (not.to === 'plus_one' ? 1 : -1) };
            assert.equal((await outcome(() => unwrap(devices, entry, change))).expect, 'refused', `${entry.name}: ${not.why}`);
            refused += 1;
        }
    }
    assert.equal(refused, 9 * 7);
    // What's inside one that opens (another household's id, another epoch,
    // not a keyring at all) is for whoever reads a keyring to refuse. A page
    // never reads one; at this layer each opens, as wrapped.
    for (const entry of file.inside_mismatch.cases) assert.ok((await unwrap(devices, entry)).length > 0, entry.name);
});

test('take only a point on the curve, and only the two modes', async () => {
    const mine = await generateDeviceKey();
    assert.ok(looksLikePublicKey(mine.publicKey));
    assert.equal(mine.privateKey.extractable, false);
    await assert.throws(() => globalThis.crypto.subtle.exportKey('jwk', mine.privateKey), "exporting the page's own private key");
    await assert.throws(() => globalThis.crypto.subtle.exportKey('pkcs8', mine.privateKey), "exporting the page's own private key");
    const theirs = await generateDeviceKey();
    assert.equal(await dh(mine.privateKey, theirs.publicKey), await dh(theirs.privateKey, mine.publicKey));
    const offCurve = Uint8Array.from(theirs.publicKey);
    offCurve[40] ^= 0x01;
    for (const bad of [offCurve, theirs.publicKey.subarray(0, 64), new Uint8Array(65), utf8('not a key')]) {
        assert.equal((await outcome(() => dh(mine.privateKey, bad))).expect, 'refused');
        assert.equal((await outcome(() => hpkeSeal({ recipientPublicKey: bad, info: 'i', aad: 'a', plaintext: 'p' }))).expect, 'refused');
    }
    // Sealed with a key of the browser's own making, both ways round.
    for (const mode of ['base', 'auth']) {
        const sealed = await hpkeSeal({ mode, recipientPublicKey: theirs.publicKey, sender: mine, info: 'petcam.test', aad: 'for them', plaintext: 'between two devices' });
        assert.equal(textOf(await hpkeOpen({ mode, recipient: theirs, senderPublicKey: mine.publicKey, info: 'petcam.test', aad: 'for them', sealed })), 'between two devices');
        assert.equal((await outcome(() => hpkeOpen({ mode, recipient: theirs, senderPublicKey: mine.publicKey, info: 'petcam.test', aad: 'for someone else', sealed }))).expect, 'refused');
        assert.equal((await outcome(() => hpkeOpen({ mode, recipient: mine, senderPublicKey: mine.publicKey, info: 'petcam.test', aad: 'for them', sealed }))).expect, 'refused');
    }
    assert.equal((await outcome(() => hpkeOpen({ recipient: mine, info: 'i', aad: 'a', sealed: 'no dot in it' }))).expect, 'unknown_version');
    assert.equal((await outcome(() => hpkeSeal({ mode: 'auth', recipientPublicKey: theirs.publicKey, info: 'i', aad: 'a', plaintext: 'p' }))).expect, 'refused');
    assert.equal(b64url(fromB64url(b64url(mine.publicKey))), b64url(mine.publicKey));
});
