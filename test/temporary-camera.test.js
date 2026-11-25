// The page against the contract's own vectors for a temporary camera
// (vectors/temporary-camera-v1.json; docs/API.md, Temporary cameras):
// everything of it the page does, read from the file and quoted nowhere.
//
// What it pins for the home's own devices (the entry, a row, a name, an
// alert) is never a page's: a page holds no key of the home's.

import { b64url, fromB64url, textOf } from '../src/crypto/bytes.js';
import { KEYRING_INFO, PASS_INFO, hpkeOpen, keyringAad, passAad } from '../src/crypto/hpke.js';
import { inviteKeys, inviteTokenHash, nonceCommitment } from '../src/crypto/invite.js';
import { KEY_INFO, KeySet, SealContext } from '../src/crypto/keys.js';
import { looksLikePublicKey } from '../src/crypto/p256.js';
import { PEEK_FRAME_SIZE, packPeekFrame, unpackPeekFrame } from '../src/crypto/peek.js';
import { derivationKey, deriveBytes, sha256 } from '../src/crypto/primitives.js';
import { MODELS, deviceKind } from '../src/device.js';
import { cameraIdOf, isItsKeys } from '../src/join/id.js';
import { readCameraInviteLink } from '../src/join/link.js';
import { LONGEST_MS, openPass, readPassInside, takePass } from '../src/join/pass.js';
import { ASK_FOR_AT_MOST_MS } from '../src/join/worker-door.js';
import { peekSeconds, readCommand } from '../src/wire/command.js';
import { isSealed } from '../src/wire/frames.js';
import { BYE, byeSignal, offerSignal, readSignal, watchTerms } from '../src/wire/signal.js';
import { NO_VIDEO, cameraStatus, readStatus } from '../src/wire/status.js';
import { assert, suite, test, vectors } from './lib/harness.js';
import { deviceKey, holder, outcome } from './lib/keys.js';

const file = () => vectors('temporary-camera-v1');

/** Each holder the file names in `with`: the camera's keys as a member has
 * them from its entry (which open its stills too), the page's own (which
 * never do), the home's current keys, another camera's, and this camera's
 * secret held as another epoch's. @param {any} f */
async function holders(f) {
    const secret = () => fromB64url(f.camera.secret);
    return {
        camera: await KeySet.fromSecrets({ [f.camera.epoch]: secret() }, { ofACamera: true }),
        page: await KeySet.forCamera(secret(), f.camera.epoch),
        home: await holder(f, 'at_1'),
        another_camera: await KeySet.fromSecrets({ [f.camera.epoch]: fromB64url(f.camera.another_secret) }, { ofACamera: true }),
        camera_at_epoch_2: await KeySet.fromSecrets({ 2: secret() }, { ofACamera: true }),
    };
}

suite('temporary-camera-v1');

test("derive a camera's three keys from its secret, and nothing else", async () => {
    const f = await file();
    assert.equal(Object.keys(f.camera.keys).sort(), [KEY_INFO.box, KEY_INFO.media, KEY_INFO.signal].sort());
    const base = await derivationKey(fromB64url(f.camera.secret));
    for (const [info, key] of Object.entries(f.camera.keys)) assert.equal(b64url(await deriveBytes(base, info)), key, info);
    // The page's own set is one epoch, the home's as the camera started, and its secret is wiped as it's made.
    const secret = fromB64url(f.camera.secret);
    const page = await KeySet.forCamera(secret, f.camera.epoch);
    assert.equal([page.epoch, page.kept().length, secret], [f.camera.epoch, 1, new Uint8Array(32)]);
});

test("seal each message to the same bytes under the camera's own keys, and open it", async () => {
    const f = await file();
    const who = await holders(f);
    for (const [name, m] of Object.entries(f.sealed.messages)) {
        assert.equal([m.version, m.epoch], [4, f.camera.epoch], name);
        const sealer = m.sealed_with === 'camera' ? who.page : who.home;
        assert.equal((await sealer.sealText(m.plaintext, m.context, { nonce: fromB64url(m.nonce) })).sealed, m.sealed, name);
        assert.ok(isSealed({ sealed: m.sealed }), `${name}: the Worker takes it as sealed`);
        if (m.sealed_with === 'camera') assert.equal(await who.page.openText(m, m.context, { fresh: true }), m.plaintext, name);
    }
    // Its contexts are today's, with its own id in them.
    const { ids } = f;
    assert.equal(f.sealed.messages.watch.context, SealContext.signal(ids.viewer, ids.temporary_camera, ids.session));
    assert.equal(f.sealed.messages.offer.context, SealContext.signal(ids.temporary_camera, ids.viewer, ids.session));
    assert.equal(f.sealed.messages.command_end.context, SealContext.command(ids.viewer, ids.temporary_camera));
    assert.equal(f.sealed.messages.status.context, SealContext.status(ids.temporary_camera));
    assert.equal(f.sealed.still.context, SealContext.peek(ids.temporary_camera));
});

test('open what is its own, and nothing sealed with a key of the home’s, as the file says', async () => {
    const f = await file();
    const who = await holders(f);
    const seen = new Set();
    for (const c of f.sealed.opening.messages) {
        const sealed = { sealed: c.sealed ?? f.sealed.messages[c.of].sealed };
        // As everything a device acts on is opened: under its current keys only.
        const got = await outcome(() => who[c.with].openText(sealed, c.context, { fresh: true }));
        assert.equal(got.expect, c.expect, `${c.name}: ${c.why}`);
        if (c.expect === 'opens') assert.equal(got.value, f.sealed.messages[c.of].plaintext, c.name);
        // The page's own keys answer as a member's copy of them does, case for case.
        if (c.with === 'camera') assert.equal((await outcome(() => who.page.openText(sealed, c.context, { fresh: true }))).expect, c.expect, `${c.name}, by the page`);
        // And without asking for the current epoch, a camera's keys still say the same: there is no older epoch for one.
        if (c.with === 'camera' || c.with === 'camera_at_epoch_2') assert.equal((await outcome(() => who[c.with].openText(sealed, c.context))).expect, c.expect, `${c.name}, not asked as fresh`);
        seen.add(c.expect);
    }
    assert.equal(seen, new Set(['opens', 'refused', 'unknown_keys']));
    assert.ok(f.sealed.opening.messages.length >= 27);
});

test('seal a still to the same bytes, one size whatever the picture, that only its own camera’s keys open', async () => {
    const f = await file();
    const who = await holders(f);
    const still = f.sealed.still;
    const frame = packPeekFrame(fromB64url(still.jpeg), still.captured_at);
    assert.equal([frame.length, Array.from(await sha256(frame), (byte) => byte.toString(16).padStart(2, '0')).join('')], [PEEK_FRAME_SIZE, still.plaintext_sha256_hex]);
    // The page seals it, with its media key, which seals and never opens.
    const sealed = await who.page.sealMedia(frame, still.context, { nonce: fromB64url(still.nonce) });
    assert.equal([b64url(sealed), sealed.length, sealed[0]], [still.sealed, still.size, still.version]);
    assert.ok(await assert.throws(() => who.page.openMedia(sealed, still.context), 'the page never opens a still, its own included'));
    for (const c of f.sealed.opening.still) {
        const bytes = c.sealed ? fromB64url(c.sealed) : sealed;
        const got = await outcome(() => who[c.with].openMedia(bytes, c.context, { fresh: true }));
        assert.equal(got.expect, c.expect, `${c.name}: ${c.why}`);
        if (c.expect === 'opens') {
            const inside = unpackPeekFrame(got.value);
            assert.equal([inside.capturedAtMs, inside.jpeg], [still.captured_at, fromB64url(still.jpeg)], c.name);
        }
    }
    assert.equal(b64url(fromB64url(f.sealed.still_under_the_homes_keys)).length > 0, true);
});

test("sign an offer and check an answer with the camera's signal key, never the home's", async () => {
    const f = await file();
    const who = await holders(f);
    const s = f.sealed.signatures;
    assert.equal(await who.page.sign(`${s.session}|offer|${s.offer.sdp}`), s.offer.sig);
    assert.equal(await who.page.sign(`${s.session}|answer|${s.answer.sdp}`), s.answer.sig);
    for (const check of s.checks) {
        const keys = check.with === 'camera' ? who.page : who[check.with];
        assert.equal(await keys.verify(`${check.session ?? s.session}|${check.kind}|${check.sdp}`, check.sig), check.ok, check.why);
    }
    assert.ok(s.checks.some((check) => check.with === 'home' && !check.ok), "the home's key signs nothing of a temporary camera's");
});

test("read a watch with who's calling, and write a status as the file has them, field for field", async () => {
    const f = await file();
    const m = f.sealed.messages;
    const watch = readSignal(JSON.parse(m.watch.plaintext));
    assert.equal([watch.kind, watch.viewerName, watchTerms(watch)], ['watch', "Maya's iPhone", { audio: true, quality: 'auto', warm: false, relay: true }]);
    // From the same facts the page writes the same text as the two statuses there.
    const facts = (text) => JSON.parse(text);
    const seeing = facts(m.status.plaintext);
    assert.equal(JSON.stringify({ ...cameraStatus({ viewers: seeing.viewers, noVideo: null, cameraPosition: seeing.camera_position, battery: 0.6659, charging: seeing.charging, appVersion: seeing.app_version, endsAt: seeing.ends_at }), sent_at: seeing.sent_at }), m.status.plaintext);
    const hidden = facts(m.status_cannot_see.plaintext);
    assert.equal(hidden.no_video, NO_VIDEO.background);
    assert.equal(JSON.stringify({ ...cameraStatus({ viewers: hidden.viewers, noVideo: hidden.no_video, cameraPosition: hidden.camera_position, battery: null, charging: null, appVersion: hidden.app_version, endsAt: hidden.ends_at }), sent_at: hidden.sent_at }), m.status_cannot_see.plaintext);
    // It says nothing a member doesn't read of one, but which way its camera faces, which a member passes over.
    const reads = f.sealed.status_reads;
    for (const c of reads.cases.filter((each) => each.of !== 'status_claiming_more')) {
        const said = facts(m[c.of].plaintext);
        assert.equal(Object.keys(said).filter((key) => !reads.fields.includes(key)), ['camera_position'], c.of);
        assert.equal(Object.fromEntries(reads.fields.filter((key) => key in said).map((key) => [key, said[key]])), c.reads, c.of);
        assert.ok(readStatus(said) !== null, `${c.of}: an app reads it`);
    }
    // And never what the status that claims more claims: a page has none of it to say.
    const claimed = Object.keys(facts(m.status_claiming_more.plaintext)).filter((key) => !reads.fields.includes(key) && key !== 'camera_position');
    assert.ok(claimed.includes('zoom_range') && claimed.includes('armed') && claimed.includes('light') && claimed.includes('detection'));
    const most = cameraStatus({ viewers: 3, noVideo: 'stalled', cameraPosition: 'back', battery: 1, charging: false, appVersion: 'web (1)', endsAt: 1 });
    assert.equal(Object.keys(most).filter((key) => claimed.includes(key)), []);
});

test('take the three commands a member sends it, and know every other for one it does nothing for', async () => {
    const f = await file();
    const m = f.sealed.messages;
    const read = (name) => readCommand(JSON.parse(m[name].plaintext));
    const [peek, keep, end] = [read('command_peek'), read('command_keep'), read('command_end')];
    assert.equal([peek.command.name, peekSeconds(peek.command)], ['peek', 1]);
    assert.equal([keep.command.name, keep.command.value, keep.sentAt], ['keep', JSON.parse(m.command_keep.plaintext).command.value, JSON.parse(m.command_keep.plaintext).sent_at]);
    assert.equal([end.command.name, end.command.value], ['end', null]);
    assert.equal([peek, keep, end].map((command) => command.command.name), f.sealed.commands.takes);
    // The rest read as commands, as any name does, and the camera does nothing for them (test/app.browser.js runs each past a camera).
    for (const never of f.sealed.commands.never_sent) {
        const command = readCommand({ command: never, sent_at: 1, id: 'x' });
        assert.ok(command !== null && !f.sealed.commands.takes.includes(command.command.name), never.name);
    }
    assert.ok(f.sealed.commands.never_sent.length >= 15);
});

test('read the Relay switch from a watch, and say it in an offer and a bye as the file does', async () => {
    const f = await file();
    const m = f.sealed.messages;
    for (const c of f.sealed.relay.cases) {
        const said = readSignal(JSON.parse(m[c.of].plaintext));
        // Only ever said as false: missing, the side that sent it has the relay.
        assert.equal(said.relay ?? true, c.has_relay, c.of);
        if (said.kind === 'watch') assert.equal(watchTerms(said).relay, c.has_relay, c.of);
    }
    // An offer for a session made without the relay is the same offer with `"relay": false` after its signature, which is the same either way.
    const plain = JSON.parse(m.offer.plaintext);
    const without = JSON.parse(m.offer_without_the_relay.plaintext);
    assert.equal([without.sdp, without.sig], [plain.sdp, plain.sig], '`relay` is outside what `sig` covers');
    assert.equal(JSON.stringify({ ...offerSignal(without.sdp, without.sig, false), sent_at: without.sent_at }), m.offer_without_the_relay.plaintext);
    assert.equal(JSON.stringify({ ...offerSignal(plain.sdp, plain.sig), sent_at: plain.sent_at }), m.offer.plaintext);
    const bye = JSON.parse(m[f.sealed.relay.bye.of].plaintext);
    assert.equal([f.sealed.relay.bye.reason, BYE.relayOff], ['relay_off', 'relay_off']);
    assert.equal(JSON.stringify({ ...byeSignal(BYE.relayOff), sent_at: bye.sent_at }), m.bye_relay_off.plaintext);
});

test('read a link as its own only at its own address, whole, with a path or at a root', async () => {
    const f = await file();
    let read = 0;
    let refused = 0;
    for (const [page, at] of [[f.invite.link.page, f.invite.link], [f.invite.link.at_a_root.page, f.invite.link.at_a_root]]) {
        assert.ok(at.link.startsWith(`${page}#`));
        for (const c of at.reads) {
            const got = readCameraInviteLink(c.link, page);
            assert.equal([got?.inviteId, got && b64url(got.token)], [c.invite_id, c.token], c.why);
            read += 1;
        }
        for (const c of at.refused) {
            assert.equal(readCameraInviteLink(c.link, page), null, c.why);
            refused += 1;
        }
    }
    assert.equal([read, refused], [3, 22]);
    assert.equal([f.invite.link.reads[0].invite_id, f.invite.link.reads[0].token], [f.invite.id, f.invite.token]);
    // The link of a page with a path isn't a root's, and a root's isn't its: an address is compared whole.
    assert.equal([readCameraInviteLink(f.invite.link.link, f.invite.link.at_a_root.page), readCameraInviteLink(f.invite.link.at_a_root.link, f.invite.link.page)], [null, null]);
    for (const not of [null, undefined, 7, '', '#']) assert.equal(readCameraInviteLink(not, f.invite.link.page), null);
    assert.equal(readCameraInviteLink(f.invite.link.link, null), null, 'a build that carries no address reads no link');
});

test('ask with the invite as any device does: its proof, its commitment and the six digits', async () => {
    const f = await file();
    const { invite } = f;
    const request = invite.request;
    assert.equal(await inviteTokenHash(fromB64url(invite.token)), invite.token_hash);
    const keys = await inviteKeys(fromB64url(invite.token));
    assert.equal(keys.tokenHash, invite.token_hash);
    assert.equal(await nonceCommitment(fromB64url(request.joiner_nonce)), request.nonce_commitment);
    assert.equal(await keys.proof(invite.id, request.public_key, request.nonce_commitment), request.proof);
    assert.equal(await keys.code(invite.id, request.public_key, fromB64url(request.joiner_nonce), request.member_nonce), request.code);
    assert.ok(/^\d{3} \d{3}$/.test(request.code));
    // The key it asks with is the page's own, a point as the Worker asks of any.
    assert.equal([request.public_key, looksLikePublicKey(fromB64url(request.public_key))], [f.devices.page.public_key, true]);
});

test('open a pass only as its own, from its sender, and never a keyring as one', async () => {
    const f = await file();
    const { pass, devices } = f;
    const page = await deviceKey(devices.page.private_key, devices.page.public_key);
    const stranger = await deviceKey(devices.stranger.private_key, devices.stranger.public_key);
    assert.equal([pass.info, PASS_INFO], ['petcam.campass.v1', 'petcam.campass.v1']);
    assert.equal(passAad(f.household_id, f.ids.temporary_camera, f.camera.epoch), pass.associated_data.value);
    /** @param {any} wrapped @param {Record<string, any>} [change] */
    const open = (wrapped, change = {}) => outcome(() => hpkeOpen({
        mode: 'auth', recipient: change.recipient ?? page, senderPublicKey: fromB64url(change.sender ?? devices[wrapped.from].public_key),
        info: change.info ?? PASS_INFO, aad: change.aad ?? passAad(change.household ?? wrapped.household_id, change.camera ?? wrapped.camera_id, change.epoch ?? wrapped.epoch), sealed: wrapped.wrapped,
    }));
    let opened = 0;
    for (const wrapped of [...pass.sealed_by_script, ...pass.sealed_by_cryptokit]) {
        assert.equal(wrapped.aad, passAad(wrapped.household_id, wrapped.camera_id, wrapped.epoch), wrapped.name);
        const got = await open(wrapped);
        assert.equal(got.expect, 'opens', wrapped.name);
        const text = textOf(got.value);
        // What the script wrapped is its plaintext to the byte; what CryptoKit wrapped, the text Swift wrote.
        assert.equal(text, wrapped.plaintext_as_swift_wrote_it ?? pass.plaintexts[wrapped.plaintext].text, wrapped.name);
        const inside = JSON.parse(text);
        const reads = wrapped.reads ?? pass.plaintexts[wrapped.plaintext].reads;
        assert.equal([inside.secret, inside.epoch, inside.started_at, inside.ends_at, inside.latest_end, inside.started_by_name ?? null], [reads.secret, reads.epoch, reads.started_at, reads.ends_at, reads.latest_end, reads.started_by_name], wrapped.name);
        opened += 1;
        // Each opens only as it was wrapped.
        for (const refuse of pass.must_refuse.changes) {
            const change = refuse.change === 'sender' ? { sender: devices[refuse.to].public_key }
                : refuse.change === 'recipient_key' ? { recipient: stranger }
                : refuse.change === 'camera_id' ? { camera: refuse.to }
                : refuse.change === 'household_id' ? { household: refuse.to }
                : refuse.change === 'epoch' ? { epoch: wrapped.epoch + (refuse.to === 'plus_one' ? 1 : -1) }
                : { info: KEYRING_INFO, aad: keyringAad(wrapped.household_id, wrapped.camera_id, wrapped.epoch) };
            assert.equal((await open(wrapped, change)).expect, 'refused', `${wrapped.name}: ${refuse.why}`);
        }
    }
    assert.equal([opened, pass.must_refuse.changes.length], [5, 7]);
    // The home's keys wrapped as a keyring for the page's own key: it opens as a keyring, which no page ever asks for, and never as a pass.
    const keyring = pass.a_keyring_for_the_page;
    const asAKeyring = { mode: 'auth', recipient: page, senderPublicKey: fromB64url(devices.member.public_key), info: KEYRING_INFO, aad: keyring.aad, sealed: keyring.wrapped };
    assert.equal((await outcome(() => hpkeOpen({ ...asAKeyring, info: PASS_INFO, aad: passAad(keyring.household_id, keyring.recipient, keyring.epoch) }))).expect, 'refused');
    assert.equal(textOf(await hpkeOpen(asAKeyring)), keyring.plaintext);
});

test("make its device id from its key, and from nothing that isn't one", async () => {
    const f = await file();
    for (const c of f.device_id.cases) assert.equal(await cameraIdOf(fromB64url(c.public_key)), c.id, c.what);
    assert.equal(await cameraIdOf(fromB64url(f.devices.page.public_key)), f.ids.temporary_camera);
    // Version 8 and RFC 9562's variant, lowercase: never an id an app takes for itself, which is a random one.
    const anApps = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const c of f.device_id.cases) assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.id) && !anApps.test(c.id), c.id);
    for (const id of f.device_id.an_apps.takes) assert.ok(anApps.test(id), id);
    assert.ok(f.device_id.an_apps.refuses.some((refused) => refused.id === f.ids.temporary_camera));
    for (const not of f.device_id.not_keys) {
        const made = await outcome(async () => cameraIdOf(fromB64url(not.public_key)));
        assert.equal(made.expect, 'refused', not.why);
    }
    assert.equal([f.device_id.cases.length, f.device_id.not_keys.length], [3, 4]);
    // The page asks of every id the Worker gives it whether it is its key's.
    const key = fromB64url(f.devices.page.public_key);
    assert.equal([await isItsKeys(f.ids.temporary_camera, key), await isItsKeys(f.ids.members_camera, key), await isItsKeys(f.ids.temporary_camera.toUpperCase(), key), await isItsKeys(undefined, key), await isItsKeys(f.ids.temporary_camera, new Uint8Array(64))], [true, false, false, false, false]);
});

test("read what's inside a pass, and refuse everything the file says isn't one", async () => {
    const f = await file();
    const { pass } = f;
    assert.equal(LONGEST_MS, f.rules.longest_ms);
    // A request is given up on only once the camera invite it was made with has surely run out.
    assert.ok(ASK_FOR_AT_MOST_MS > f.rules.camera_invite_ms);
    for (const [name, c] of Object.entries(pass.plaintexts)) {
        const inside = readPassInside(c.text);
        assert.equal([b64url(inside.secret), inside.epoch, inside.startedAt, inside.endsAt, inside.latestEnd, inside.startedByName], [c.reads.secret, c.reads.epoch, c.reads.started_at, c.reads.ends_at, c.reads.latest_end, c.reads.started_by_name], name);
    }
    for (const c of pass.plaintexts_refused) {
        const got = await outcome(async () => readPassInside(c.text));
        assert.equal(got.expect, 'refused', `${c.name}: ${c.why}`);
    }
    assert.equal([Object.keys(pass.plaintexts).length, pass.plaintexts_refused.length], [5, 23]);
    // What CryptoKit wrote reads the same way.
    for (const wrapped of pass.sealed_by_cryptokit) {
        const inside = readPassInside(wrapped.plaintext_as_swift_wrote_it);
        assert.equal([b64url(inside.secret), inside.epoch, inside.startedAt, inside.endsAt, inside.latestEnd, inside.startedByName], [wrapped.reads.secret, wrapped.reads.epoch, wrapped.reads.started_at, wrapped.reads.ends_at, wrapped.reads.latest_end, wrapped.reads.started_by_name], wrapped.name);
    }
    // And one that opens, with what's inside at odds with what it was wrapped as, is refused as the file says.
    const page = await deviceKey(f.devices.page.private_key, f.devices.page.public_key);
    for (const c of pass.inside_mismatch.cases) {
        const got = await outcome(() => openPass({ deviceKey: page, senderPublicKey: f.devices[c.from].public_key, householdId: c.household_id, cameraId: c.camera_id, epoch: c.epoch, wrapped: c.wrapped }));
        assert.equal(got.expect, c.expect, `${c.name}: ${c.why}`);
    }
    assert.equal(pass.inside_mismatch.cases.length, 4);
    for (const wrapped of [...pass.sealed_by_script, ...pass.sealed_by_cryptokit]) {
        const inside = await openPass({ deviceKey: page, senderPublicKey: f.devices[wrapped.from].public_key, householdId: wrapped.household_id, cameraId: wrapped.camera_id, epoch: wrapped.epoch, wrapped: wrapped.wrapped });
        assert.equal([b64url(inside.secret), inside.epoch], [f.camera.secret, f.camera.epoch], wrapped.name);
    }
});

test('take a pass in its order, and only then: its id, the approval, what it opens as, its epoch, its end', async () => {
    const f = await file();
    const approval = f.pass.approval;
    const page = await deviceKey(f.devices.page.private_key, f.devices.page.public_key);
    const invite = await inviteKeys(fromB64url(f.invite.token));
    assert.equal(await invite.approvalHolds(approval.invite_id, approval.device_id, approval.listed), true);
    /** @param {any} c one of the file's cases @param {Record<string, unknown>} [more] */
    const take = (c, more = {}) => outcome(() => takePass({
        deviceKey: page, givenId: c.device_id ?? approval.device_id, householdId: c.household_id ?? approval.household_id,
        inviteId: approval.invite_id, invite, listed: { ...approval.listed, ...(c.change ?? {}) }, now: c.now, ...more,
    }));
    const seen = new Set();
    for (const c of approval.taking) {
        const got = await take(c);
        assert.equal(got.expect, c.expect === 'takes' ? 'opens' : c.expect, `${c.name}: ${c.why}`);
        seen.add(c.expect);
        if (c.expect !== 'takes') continue;
        // What it makes: its own id, the keys its secret gives, its times, and whoever started it.
        const taken = got.value;
        assert.equal([taken.cameraId, taken.keys.epoch, taken.startedAt, taken.endsAt, taken.latestEndAt, taken.startedBy], [f.ids.temporary_camera, f.camera.epoch, 1767225600000, 1767312000000, 1767830400000, 'Maya Lopez'], c.name);
        const said = f.sealed.messages.status;
        assert.equal((await taken.keys.sealText(said.plaintext, said.context, { nonce: fromB64url(said.nonce) })).sealed, said.sealed, `${c.name}: its keys are the camera's own`);
        for (const key of taken.keys.kept().flatMap((kept) => [kept.box, kept.media, kept.signal])) assert.equal(key.extractable, false);
    }
    assert.equal([approval.taking.length, [...seen].sort()], [15, ['over', 'refused', 'takes', 'unknown_keys']]);
    // The order: an id that isn't its key's is refused before anything else is looked at, whatever is listed.
    const wrongId = approval.taking.find((c) => c.name === 'an_id_that_is_not_its_keys');
    const asked = [];
    const watched = { approvalHolds: (...all) => (asked.push(all), invite.approvalHolds(...all)) };
    assert.equal((await take(wrongId, { invite: watched })).expect, 'refused');
    assert.equal(asked.length, 0, 'the MAC is never asked under an id that is not its key’s');
    // Then the MAC, before the pass is opened: a pass that would open is refused under a MAC that doesn't hold.
    assert.equal((await take({ now: approval.taking[0].now, change: { approval_mac: f.pass.approval.taking.find((c) => c.name === 'mac_for_another_epoch').change.approval_mac } })).expect, 'refused');
    // Its end is asked last: past it, a pass that isn't authentic is still refused, not over.
    assert.equal((await take({ now: 1767312000000, change: { approval_mac: null } })).expect, 'refused');
    assert.equal((await take({ now: 1767312000000, household_id: f.ids.another_household })).expect, 'refused');
    // What isn't a listing at all, or names no household, is refused too.
    for (const listed of [null, undefined, 7, 'pass', [], { ...approval.listed, epoch: '1' }, { ...approval.listed, epoch: -1 }, { ...approval.listed, pass: undefined }, { ...approval.listed, from_public_key: 7 }]) {
        const got = await outcome(() => takePass({ deviceKey: page, givenId: approval.device_id, householdId: approval.household_id, inviteId: approval.invite_id, invite, listed, now: approval.taking[0].now }));
        assert.equal(got.expect, 'refused', JSON.stringify(listed)?.slice(0, 60));
    }
    for (const householdId of [null, undefined, '', 7]) assert.equal((await take({ now: approval.taking[0].now, household_id: undefined }, { householdId })).expect, 'refused');
    // Under another device's id or another invite's, the same MAC says nothing; nor with nothing handed over.
    assert.equal(await invite.approvalHolds(approval.invite_id, f.ids.other_device, approval.listed), false);
    assert.equal(await invite.approvalHolds(f.ids.another_invite, approval.device_id, approval.listed), false);
    assert.equal(await invite.approvalHolds(approval.invite_id, approval.device_id, { ...approval.listed, pass: undefined }), false);
});

test('say what its device is in one of the eight words the apps show, and no other', async () => {
    const f = await file();
    assert.equal([...MODELS].sort(), [...f.models.known].sort());
    for (const c of f.models.cases) assert.equal(MODELS.includes(c.model) ? c.model : null, c.shows, c.why ?? c.model);
    // Every one of the eight is a device the page can tell, and it never says anything else.
    const agents = [
        { userAgent: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36' },
        { userAgent: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36' },
        { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1' },
        { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', maxTouchPoints: 5 },
        { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15', maxTouchPoints: 0 },
        { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36' },
        { userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36' },
        { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36' },
    ];
    assert.equal(agents.map((agent) => deviceKind(agent).name), f.models.known);
    for (const agent of [{}, { userAgent: '' }, { userAgent: 'Living room' }, { userAgent: 'curl/8.7.1' }]) assert.equal(deviceKind(agent).name, 'Computer');
});
