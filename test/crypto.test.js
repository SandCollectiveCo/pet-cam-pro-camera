// The page's keys and sealed formats against docs/vectors/ (keys-v1,
// sealed-v1): the checks server/test/vectors.test.ts makes of the scripts'
// crypto, for everything a camera does.

import { SealError, b64url, bigEndian, concat, fromB64url, fromBigEndian, fromHex, hex, sameBytes, textOf, utf8 } from '../src/crypto/bytes.js';
import { KEY_INFO, KeySet, SealContext } from '../src/crypto/keys.js';
import { PEEK_FRAME_SIZE, PEEK_JPEG_MAX, fitsPeekFrame, packPeekFrame, unpackPeekFrame } from '../src/crypto/peek.js';
import { derivationKey, deriveBytes, sha256 } from '../src/crypto/primitives.js';
import { assert, suite, test, vectors } from './lib/harness.js';
import { holder, outcome } from './lib/keys.js';

suite('bytes');

test('base64url both ways, and the standard alphabet read as the apps read it', async () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 255]) {
        const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 251) & 0xff);
        const text = b64url(bytes);
        assert.ok(/^[A-Za-z0-9_-]*$/.test(text), 'no padding, no + or /');
        assert.equal(fromB64url(text), bytes);
    }
    assert.equal(b64url(Uint8Array.of(0xfb, 0xff)), '-_8');
    assert.equal(fromB64url('+/8='), Uint8Array.of(0xfb, 0xff));
    assert.equal(fromB64url('-_8'), Uint8Array.of(0xfb, 0xff));
    for (const not of ['not base64url!', 'a b', 'ab=c', 'abc===', 12, null, undefined]) {
        const error = await assert.throws(() => fromB64url(/** @type {any} */ (not)), `${not} isn't base64url`);
        assert.ok(error instanceof SealError && error.code === 'malformed');
    }
});

test('numbers big-endian, hex, UTF-8', () => {
    assert.equal(bigEndian(1, 4), Uint8Array.of(0, 0, 0, 1));
    assert.equal(bigEndian(1767225600123, 8), fromHex('0000019b76daa87b'));
    assert.equal(fromBigEndian(fromHex('0000019b76daa87b')), 1767225600123);
    assert.equal(hex(concat('ab', Uint8Array.of(0, 255))), '616200ff');
    assert.equal(textOf(utf8('Küche 🐶')), 'Küche 🐶');
    assert.ok(sameBytes(utf8('abc'), utf8('abc')) && !sameBytes(utf8('abc'), utf8('abd')) && !sameBytes(utf8('abc'), utf8('ab')));
});

suite('keys-v1');

test('derive every key an epoch gives, to the byte', async () => {
    const file = await vectors('keys-v1');
    assert.equal(file.epochs.length, 3);
    for (const epoch of file.epochs) {
        const base = await derivationKey(fromB64url(epoch.secret));
        assert.equal(Object.keys(epoch.keys).length, 10);
        // Every info in the file, though a camera only ever uses three: it
        // is HKDF with the apps' salt that's held here.
        for (const [info, key] of Object.entries(epoch.keys)) assert.equal(b64url(await deriveBytes(base, info)), key, `epoch ${epoch.epoch}, ${info}`);
        for (const info of Object.values(KEY_INFO)) assert.ok(info in epoch.keys, `${info} is one of the file's`);
    }
});

suite('sealed-v1');

test('seal each message to the same bytes, given its nonce', async () => {
    const file = await vectors('sealed-v1');
    const keys = await holder(file, 'at_2');
    let sealed = 0;
    for (const [name, m] of Object.entries(file.messages)) {
        assert.equal(fromB64url(m.sealed)[0], m.version, name);
        assert.equal(KeySet.epochOfMessage(m), m.epoch, name);
        // 0x02 is from before keys could change: it is opened (below), and nothing seals it now.
        if (m.version !== 4) continue;
        const again = await keys.sealText(m.plaintext, m.context, { nonce: fromB64url(m.nonce), epoch: m.epoch });
        assert.equal(again.sealed, m.sealed, name);
        sealed += 1;
    }
    assert.ok(sealed >= 16, `sealed ${sealed} of the file's messages`);
    // The contexts a camera seals and opens are written here as the file writes them.
    const ids = file.ids;
    assert.equal(SealContext.signal(ids.viewer, ids.camera, ids.session), file.messages.signal.context);
    assert.equal(SealContext.command(ids.viewer, ids.camera), file.messages.command.context);
    assert.equal(SealContext.status(ids.camera), file.messages.status.context);
    assert.equal(SealContext.peek(ids.camera), file.media.peek.context);
});

test('open each message for the right device, and fail every other way as the file says', async () => {
    const file = await vectors('sealed-v1');
    const failures = new Set();
    for (const c of file.opening.messages) {
        const of = file.messages[c.of];
        const message = { sealed: c.sealed ?? of.sealed };
        const keys = await holder(file, c.holder);
        const got = await outcome(() => keys.openText(message, c.context, { fresh: c.only_current }));
        assert.equal(got.expect, c.expect, `${c.name}: ${c.why}`);
        if (c.expect === 'opens') assert.equal(got.value, of.plaintext, c.name);
        if (c.expect === 'newer_keys') assert.equal(got.epoch, c.epoch, c.name);
        failures.add(c.expect);
    }
    assert.equal(failures, new Set(['opens', 'refused', 'stale_keys', 'newer_keys', 'unknown_keys', 'unknown_version']));
});

test('seal media to the same bytes, and open it only as what it is', async () => {
    const file = await vectors('sealed-v1');
    const frame = packPeekFrame(fromB64url(file.peek_frame.jpeg), file.peek_frame.captured_at);
    const plaintextOf = (vector) => (vector.plaintext === undefined ? frame : fromB64url(vector.plaintext));
    const keys = await holder(file, 'at_2');
    for (const [name, m] of Object.entries(file.media)) {
        // Media bound to nothing (0x03, 0x01) is from before 2026-11-03:
        // nothing seals it, and it must not open (below).
        if (m.context === null) continue;
        const again = await keys.sealMedia(plaintextOf(m), m.context, { nonce: fromB64url(m.nonce), epoch: m.epoch });
        assert.equal(b64url(again), m.sealed, name);
        assert.equal(KeySet.epochOfMedia(again), m.epoch, name);
        if (m.plaintext_sha256_hex) assert.equal(hex(await sha256(plaintextOf(m))), m.plaintext_sha256_hex, name);
    }
    for (const c of file.opening.media) {
        const of = file.media[c.of];
        const bytes = fromB64url(c.sealed ?? of.sealed);
        const holding = await holder(file, c.holder);
        const got = await outcome(() => holding.openMedia(bytes, c.context, { epoch: c.media_epoch, fresh: c.only_current }));
        assert.equal(got.expect, c.expect, `${c.name}: ${c.why}`);
        if (c.expect === 'opens') assert.equal(got.value, plaintextOf(of), c.name);
        if (c.expect === 'newer_keys') assert.equal(got.epoch, c.epoch, c.name);
    }
    assert.equal(KeySet.epochOfMedia(fromB64url(file.media.unbound_v03.sealed)), null);
});

test('pack a still to one size, with its time inside', async () => {
    const peek = (await vectors('sealed-v1')).peek_frame;
    const packed = packPeekFrame(fromB64url(peek.jpeg), peek.captured_at);
    assert.equal(packed.length, peek.size);
    assert.equal(peek.size, PEEK_FRAME_SIZE);
    assert.equal(hex(await sha256(packed)), peek.packed_sha256_hex);
    assert.equal(fromBigEndian(packed.subarray(0, 8)), peek.captured_at);
    const back = unpackPeekFrame(packed);
    assert.equal(back.capturedAtMs, peek.captured_at);
    assert.equal(b64url(back.jpeg), peek.jpeg);
    for (const also of peek.also) {
        const unpacked = unpackPeekFrame(fromB64url(also.packed));
        if (also.unpacks === false) assert.equal(unpacked, null, also.what);
        else assert.equal({ captured_at: unpacked.capturedAtMs, jpeg: b64url(unpacked.jpeg) }, { captured_at: also.captured_at, jpeg: also.jpeg }, also.what);
    }
    assert.equal(peek.fits.largest_jpeg_bytes, PEEK_JPEG_MAX);
    const largest = new Uint8Array(PEEK_JPEG_MAX).fill(1);
    assert.equal(packPeekFrame(largest, 0).length, peek.size);
    assert.ok(fitsPeekFrame(largest) && !fitsPeekFrame(new Uint8Array(PEEK_JPEG_MAX + 1)) && !fitsPeekFrame(new Uint8Array(0)));
    assert.ok(packPeekFrame(new Uint8Array(PEEK_JPEG_MAX + 1).fill(1), 0).length > peek.size, 'one byte more no longer fits');
});

test("sign an offer and an answer with the current epoch's key only", async () => {
    const file = await vectors('sealed-v1');
    const s = file.signatures;
    const signer = await holder(file, s.signer);
    for (const signed of [s.offer, s.answer]) assert.equal(await signer.sign(`${s.session}|${signed.kind}|${signed.sdp}`), signed.sig, signed.kind);
    assert.ok(s.offer.sdp.includes('\r\n'));
    for (const check of s.checks) {
        const keys = await holder(file, check.holder);
        assert.equal(await keys.verify(`${check.session ?? s.session}|${check.kind}|${check.sdp}`, check.sig), check.ok, check.why);
    }
    for (const not of ['', 'AAAA', 'not base64url!', 7, {}]) assert.equal(await signer.verify(`${s.session}|offer|${s.offer.sdp}`, not), false);
});

suite("a camera's own keys");

test('come from its secret as an epoch’s do, seal as the vectors seal, and wipe the secret', async () => {
    const file = await vectors('sealed-v1');
    // The same secret as the vectors' epoch 1, held as a camera would hold
    // its own: one epoch, the home's when it started.
    const secret = fromB64url(file.epochs['1']);
    const camera = await KeySet.forCamera(secret, 1);
    assert.equal(secret, new Uint8Array(32), 'the secret handed over is wiped');
    assert.equal(camera.epoch, 1);
    for (const name of ['signal', 'command', 'status']) {
        const m = file.messages[name];
        assert.equal((await camera.sealText(m.plaintext, m.context, { nonce: fromB64url(m.nonce) })).sealed, m.sealed, name);
        assert.equal(await camera.openText(m, m.context, { fresh: true }), m.plaintext, name);
    }
    const peek = file.media.peek;
    const frame = packPeekFrame(fromB64url(file.peek_frame.jpeg), file.peek_frame.captured_at);
    assert.equal(b64url(await camera.sealMedia(frame, peek.context, { nonce: fromB64url(peek.nonce) })), peek.sealed);
    assert.equal(await camera.sign(`${file.signatures.session}|offer|${file.signatures.offer.sdp}`), file.signatures.offer.sig);
    // What's sealed under another epoch isn't the camera's, older or newer:
    // a camera's keys never say "older keys" or "catch up", whichever way
    // they're asked (vectors/temporary-camera-v1.json pins the same).
    for (const how of [{ fresh: true }, {}]) {
        assert.equal((await outcome(() => camera.openText(file.messages.command_epoch_0, file.messages.command_epoch_0.context, how))).expect, 'unknown_keys');
        assert.equal((await outcome(() => camera.openText(file.messages.home_name_epoch_2, file.messages.home_name_epoch_2.context, how))).expect, 'unknown_keys');
    }
});

test('can be used and never read out', async () => {
    const camera = await KeySet.forCamera(globalThis.crypto.getRandomValues(new Uint8Array(32)), 3);
    const [kept] = camera.kept();
    for (const key of [kept.box, kept.media, kept.signal]) {
        assert.equal(key.extractable, false);
        for (const format of ['raw', 'jwk']) {
            const error = await assert.throws(() => globalThis.crypto.subtle.exportKey(format, key), `exporting a camera's key as ${format}`);
            assert.ok(error instanceof Error);
        }
    }
    // A camera seals stills and never opens one.
    assert.equal([...kept.media.usages], ['encrypt']);
    assert.equal(KeySet.fromKept(camera.kept()).epoch, 3);
    // What storage hands back is checked, not trusted: only what `kept` writes is taken.
    const [good] = camera.kept();
    const readable = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const signing = await globalThis.crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const wrapping = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
    for (const [what, kept] of [
        ['nothing', undefined], ['null', null], ['no keys', []], ['text', 'keys'], ['an entry of nothing', [null]],
        ['no epoch', [{ ...good, epoch: undefined }]], ['half an epoch', [{ ...good, epoch: 1.5 }]], ['a negative epoch', [{ ...good, epoch: -1 }]],
        ['one epoch twice', [good, good]],
        ['a key in bytes', [{ ...good, box: new Uint8Array(32) }]], ['a key that can be read out', [{ ...good, box: readable }]],
        ['a signing key where a sealing key goes', [{ ...good, media: signing }]], ['a sealing key where the signing key goes', [{ ...good, signal: good.box }]],
        ['a key for another use', [{ ...good, box: wrapping }]], ['no signing key', [{ epoch: 3, box: good.box, media: good.media }]],
    ]) {
        const error = await assert.throws(() => KeySet.fromKept(/** @type {any} */ (kept)), `kept: ${what}`);
        assert.equal(error.code, 'malformed', what);
    }
});
