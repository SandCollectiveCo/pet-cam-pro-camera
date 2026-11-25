// The asking side of an invite against docs/vectors/invite-v1.json: the
// token's hash, what a request commits to, its proof, the six digits, and
// the approval's MAC over what's handed back.

import { fromB64url, textOf } from '../src/crypto/bytes.js';
import { KEYRING_INFO, hpkeOpen, keyringAad } from '../src/crypto/hpke.js';
import { inviteKeys, inviteTokenHash, nonceCommitment, nonceCommitmentWithKey } from '../src/crypto/invite.js';
import { assert, suite, test, vectors } from './lib/harness.js';
import { deviceKey, outcome } from './lib/keys.js';

suite('invite-v1');

test('hash the token and commit to a nonce as the Worker checks them', async () => {
    const file = await vectors('invite-v1');
    assert.equal(await inviteTokenHash(fromB64url(file.invite.token)), file.invite.token_hash);
    assert.equal((await inviteKeys(fromB64url(file.invite.token))).tokenHash, file.invite.token_hash);
    for (const request of [file.requests.a, file.requests.b, file.requests.c]) {
        const nonce = fromB64url(request.joiner_nonce);
        assert.equal(await nonceCommitment(nonce), request.commitment_nonce_alone);
        assert.equal(await nonceCommitmentWithKey(nonce, request.public_key), request.commitment_with_key);
        assert.equal(request.nonce_commitment, request.commits_to === 'with_key' ? request.commitment_with_key : request.commitment_nonce_alone);
    }
});

test('prove it holds the link, and show the code the vectors say', async () => {
    const file = await vectors('invite-v1');
    const token = fromB64url(file.invite.token);
    const keys = await inviteKeys(token);
    assert.equal(token, new Uint8Array(32), 'the token handed over is wiped');
    for (const request of [file.requests.a, file.requests.b, file.requests.c]) {
        assert.equal(await keys.proof(file.invite.id, request.public_key, request.nonce_commitment), request.proof);
        assert.equal(await keys.code(file.invite.id, request.public_key, fromB64url(request.joiner_nonce), request.member_nonce), request.code);
        assert.ok(/^\d{3} \d{3}$/.test(request.code));
    }
    // The values SharedTests/InviteKeyBindingTests.swift has pinned since 2026-11-10.
    assert.equal(file.requests.a.code, '862 673');
    assert.equal(file.requests.c.code, '962 820');
    // The keys made from a token can be used and not read.
    for (const key of [keys.proofKey, keys.codeKey, keys.approveKey]) assert.equal(key.extractable, false);
    await assert.throws(() => inviteKeys(new Uint8Array(31)), 'a token is 32 bytes');
});

test('take what it is handed only under an approval the link vouches for', async () => {
    const file = await vectors('invite-v1');
    const approval = file.approval;
    const device = file.requests.c;
    const keys = await inviteKeys(fromB64url(file.invite.token));
    const mine = await deviceKey(device.private_key, device.public_key);
    /** As a joining device takes one: the MAC first, then the wrapping. */
    const open = async (handed) => {
        if (!(await keys.approvalHolds(file.invite.id, device.device_id, handed))) return { expect: 'refused' };
        return outcome(() => hpkeOpen({
            mode: 'auth', recipient: mine, senderPublicKey: fromB64url(handed.from_public_key), info: KEYRING_INFO,
            aad: keyringAad(file.household_id, device.device_id, handed.epoch), sealed: handed.wrapped,
        }));
    };
    const opened = await open(approval.keyring);
    assert.equal(opened.expect, 'opens');
    assert.equal(textOf(opened.value), approval.keyring_plaintext);
    assert.equal(keyringAad(file.household_id, device.device_id, approval.keyring.epoch), approval.keyring_aad);
    assert.equal(approval.must_refuse.length, 5);
    for (const refused of approval.must_refuse) assert.equal((await open({ ...approval.keyring, ...refused.change })).expect, 'refused', refused.why);
    // For another device's id, or another invite, the same MAC says nothing.
    assert.equal(await keys.approvalHolds(file.invite.id, file.requests.a.device_id, approval.keyring), false);
    assert.equal(await keys.approvalHolds('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', device.device_id, approval.keyring), false);
    assert.equal(await keys.approvalHolds(file.invite.id, device.device_id, { ...approval.keyring, approval_mac: 'not base64url!' }), false);
});
