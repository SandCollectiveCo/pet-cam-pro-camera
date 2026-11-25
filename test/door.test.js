// The door into a home (src/join/worker-door.js), against a stand-in Worker
// (dev/worker.js) that also plays the home's member: registering under its
// key's own id, asking, the code, the pass taken in its order, what it keeps
// and comes back from after a reload, its socket's ticket, what it asks of
// its plan, and its end. Every refusal the contract asks of a page is tried
// here with the Worker or the member misbehaving; the vectors' own cases are
// in temporary-camera.test.js.

import { Relay } from '../dev/relay.js';
import { StandInWorker } from '../dev/worker.js';
import { b64url, fromB64url } from '../src/crypto/bytes.js';
import { KeySet, SealContext } from '../src/crypto/keys.js';
import { inviteKeys } from '../src/crypto/invite.js';
import { memoryStore } from '../src/crypto/store.js';
import { Turned, isCode } from '../src/join/door.js';
import { cameraIdOf } from '../src/join/id.js';
import { KEPT_KEY, readKept, toKeep } from '../src/join/kept.js';
import { WorkerDoor } from '../src/join/worker-door.js';
import { assert, sleep, suite, test, until } from './lib/harness.js';

suite('the door');

const PAGE = 'https://camera.example/';
/** The same steps, sooner. */
const SOON = { askEveryMs: 15, askAtMostEveryMs: 60, askForAtMostMs: 6_000, leaveWaitsMs: 250, answerWithinMs: 1_000 };
const clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

/** A home with a camera invite on a stand-in Worker, and a way to open the page.
 * @param {{ home?: any, invite?: { lastsMs?: number }, store?: import('../src/crypto/store.js').Store }} [how] */
async function aHome(how = {}) {
    const relay = new Relay();
    const worker = new StandInWorker({ relay });
    const home = await worker.home(how.home);
    const invite = worker.cameraInvite(home, how.invite);
    await invite.ready;
    const store = how.store ?? memoryStore();
    /** The page, opened at `opened`: a camera invite's link by default. @param {string} [opened] */
    const open = (opened = invite.link(PAGE)) => new WorkerDoor({
        api: worker.api, page: PAGE, opened, store, fetch: worker.fetch, WebSocket: worker.WebSocket, clock, model: 'Android phone', appVersion: 'web (0)', timing: SOON,
    });
    return { relay, worker, home, invite, store, open };
}

/** What a member does once the page has asked: answers, shows its code, and approves once the page shows the same.
 * @param {Awaited<ReturnType<typeof aHome>>} h @param {WorkerDoor} door @param {Parameters<StandInWorker['approveOn']>[1]} [how] */
async function approved(h, door, how = {}) {
    const shown = [];
    const joining = door.join((code) => shown.push(code));
    const code = await asked(h, shown);
    const memberKeys = await h.worker.approveOn(h.invite.id, how);
    return { pass: await joining, code, shown, memberKeys };
}

/** The page asks, a member answers, and both show the same six digits. @param {Awaited<ReturnType<typeof aHome>>} h @param {string[]} shown */
async function asked(h, shown) {
    await until(() => h.worker.requestOn(h.invite.id), 'the page to ask', 5_000, 5);
    h.worker.answerOn(h.invite.id);
    const code = await until(() => h.worker.codeOn(h.invite.id), "the member's code", 5_000, 5);
    await until(() => shown.at(-1) === code, 'the page to show the same code', 5_000, 5);
    return code;
}

/** Whether anything in what was kept holds these bytes, as bytes or as base64url text. @param {unknown} value @param {Uint8Array[]} secrets */
function holdsAny(value, secrets) {
    const texts = secrets.map((bytes) => b64url(bytes));
    const look = (v) => {
        if (v instanceof Uint8Array) return secrets.some((s) => s.length === v.length && s.every((byte, i) => byte === v[i]));
        if (typeof v === 'string') return texts.some((text) => v.includes(text));
        if (v && typeof v === 'object' && !(v instanceof CryptoKey)) return Object.values(v).some(look);
        return false;
    };
    return look(value);
}

test('gets in: registers under its key’s own id, asks, shows the code a member shows, and takes its pass', async () => {
    const h = await aHome();
    const token = Uint8Array.from(h.invite.token);
    const door = h.open();
    assert.equal(await door.arrive(), { kind: 'link' });
    assert.equal(h.worker.calls, [], 'reading a link asks nothing of the Worker');
    const { pass, code, shown, memberKeys } = await approved(h, door, { name: 'Maya Lopez' });

    // Registered as a `web` camera with its key, under the id that key makes.
    const registered = h.worker.bodies.find((b) => b.call === 'POST /v1/devices').body;
    assert.equal(Object.keys(registered).sort(), ['app_version', 'model', 'platform', 'public_key', 'role']);
    assert.equal([registered.role, registered.platform, registered.model, registered.app_version], ['camera', 'web', 'Android phone', 'web (0)']);
    assert.equal(pass.cameraId, await cameraIdOf(fromB64url(registered.public_key)));
    assert.ok(h.worker.devices.has(pass.cameraId));
    // Asked as any device does, with that key; the six digits are the member's.
    const request = h.worker.requestOn(h.invite.id);
    assert.equal([request.deviceId, request.publicKey, request.asks], [pass.cameraId, registered.public_key, 1]);
    assert.equal([shown, isCode(code)], [[code], true]);
    // In this order, and nothing else asked.
    const route = (call) => call.replace(h.invite.id, ':id');
    const calls = h.worker.calls.map(route).filter((call, i, all) => call !== all[i - 1]);
    assert.equal(calls, ['POST /v1/devices', 'POST /v1/invites/:id/requests', 'GET /v1/invites/:id/requests/me', 'POST /v1/invites/:id/requests/me/reveal', 'GET /v1/invites/:id/requests/me', 'GET /v1/me/pass', 'GET /v1/me']);
    // The camera it is: its own keys, which a member's copy opens and nothing of the home's ever does; its times; whoever started it.
    assert.equal([pass.startedBy, pass.endsAt - pass.latestEndAt], ['Maya Lopez', -6 * 86_400_000]);
    const status = await pass.keys.sealMessage({ viewers: 0, sent_at: 1 }, SealContext.status(pass.cameraId));
    assert.equal(await memberKeys.openMessage(status, SealContext.status(pass.cameraId), { fresh: true }), { viewers: 0, sent_at: 1 });
    for (const kept of pass.keys.kept()) for (const key of [kept.box, kept.media, kept.signal]) assert.equal(key.extractable, false);
    // What it keeps holds no token, no member nonce's secret and no camera secret: keys the browser keeps, and plain values.
    const record = await h.store.get(KEPT_KEY);
    assert.ok(record && record.camera && record.asking === null && record.session);
    assert.ok(!holdsAny(record, [token]), 'the link’s token is never kept');
    assert.ok(!JSON.stringify(record, (k, v) => (v instanceof Uint8Array ? b64url(v) : v)).includes(b64url(token)));
});

test('says what it registers as from what it is, and asks the Worker by its full address alone', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    const fetched = [];
    door.api.fetch = (url, init) => {
        fetched.push({ url, init });
        return h.worker.fetch(url, init);
    };
    await approved(h, door);
    assert.ok(fetched.length >= 6 && fetched.every(({ url }) => url.startsWith(`${h.worker.api}/v1/`)));
    // No cookie, no redirect followed, no cache, no referrer; a bearer token only once it has a session.
    for (const { init } of fetched) assert.equal([init.credentials, init.redirect, init.cache, init.referrerPolicy], ['omit', 'error', 'no-store', 'no-referrer']);
    assert.equal(fetched[0].init.headers.authorization, undefined, 'registering is the one call with no session');
    assert.ok(fetched.slice(1).every(({ init }) => /^Bearer .+/.test(init.headers.authorization)));
    // Its socket's address is the Worker's own, by its ticket, and says what it runs.
    const address = new URL(door.api.socketAddress('t'.repeat(43), 'web (0)'));
    assert.equal([address.protocol, address.host, address.pathname, address.searchParams.get('ticket'), address.searchParams.get('app_version')], ['wss:', 'worker.test', '/v1/realtime', 't'.repeat(43), 'web (0)']);
});

test('carries on after a reload while it asks, without asking again, and shows the same code', async () => {
    const h = await aHome();
    const first = h.open();
    await first.arrive();
    const shown = [];
    first.join((code) => shown.push(code)).catch(() => {});
    const code = await asked(h, shown);
    // Reloaded: the address has no link any more, and what it kept is the request.
    first.leaving = true;
    const again = h.open(PAGE);
    assert.equal(await again.arrive(), { kind: 'link' });
    const shownAgain = [];
    const joining = again.join((c) => shownAgain.push(c));
    await until(() => shownAgain.length > 0, 'the code again', 5_000, 5);
    assert.equal(shownAgain, [code]);
    // Asking again would clear the member's answer: it isn't asked again.
    assert.equal(h.worker.requestOn(h.invite.id).asks, 1);
    assert.equal(h.worker.calls.filter((call) => call === `POST /v1/invites/${h.invite.id}/requests`).length, 1);
    await h.worker.approveOn(h.invite.id);
    const pass = await joining;
    assert.equal(pass.cameraId, h.worker.requestOn(h.invite.id).deviceId);
});

test('carries on as the same camera after a reload, and a second link starts nothing', async () => {
    const h = await aHome();
    const first = h.open();
    await first.arrive();
    const { pass } = await approved(h, first);
    // Opened again, from another home's code: it is still the camera it was.
    const other = h.worker.cameraInvite(await h.worker.home());
    await other.ready;
    const again = h.open(other.link(PAGE));
    const arrival = await again.arrive();
    assert.equal(arrival.kind, 'kept');
    assert.equal([arrival.pass.cameraId, arrival.pass.endsAt, arrival.pass.latestEndAt, arrival.pass.startedBy, arrival.seen], [pass.cameraId, pass.endsAt, pass.latestEndAt, pass.startedBy, {}]);
    assert.equal(h.worker.requestOn(other.id), null, 'nothing asked with the second link');
    // Its keys came back from storage the same keys.
    const sealed = await pass.keys.sealMessage({ a: 1 }, SealContext.status(pass.cameraId));
    assert.equal(await arrival.pass.keys.openMessage(sealed, SealContext.status(pass.cameraId), { fresh: true }), { a: 1 });
    assert.ok(h.worker.calls.at(-1) === 'GET /v1/me', 'it asks the Worker whether the home still has it');
});

test('a camera the home ended while the page was shut is over when it is opened again, and nothing of it stays', async () => {
    const h = await aHome();
    const first = h.open();
    await first.arrive();
    const { pass } = await approved(h, first);
    h.worker.endCamera(pass.cameraId);
    const again = h.open(PAGE);
    assert.equal(await again.arrive(), { kind: 'over', why: 'gone' });
    assert.equal(await h.store.get(KEPT_KEY), undefined);
    // Gone within a minute and a half of its end is its time: the Worker ends one by its own clock, which may be ahead.
    const near = await aHome();
    const nearly = near.open();
    await nearly.arrive();
    const { pass: ending } = await approved(near, nearly, { endsAt: Date.now() + 60_000 });
    near.worker.endCamera(ending.cameraId);
    assert.equal(await near.open(PAGE).arrive(), { kind: 'over', why: 'time' });
    // While the Worker can't be reached, it carries on: its socket finds out later.
    const h2 = await aHome();
    const door = h2.open();
    await door.arrive();
    await approved(h2, door);
    h2.worker.faults.offline = true;
    assert.equal((await h2.open(PAGE).arrive()).kind, 'kept');
});

test('a camera past its end when it is opened again is over, and leaves: its device and what it kept go', async () => {
    const h = await aHome();
    const first = h.open();
    await first.arrive();
    const { pass } = await approved(h, first, { endsAt: Date.now() + 400 });
    await sleep(450);
    const again = h.open(PAGE);
    assert.equal(await again.arrive(), { kind: 'over', why: 'time' });
    await again.leave();
    assert.equal([h.worker.devices.has(pass.cameraId), await h.store.get(KEPT_KEY)], [false, undefined]);
    assert.equal(h.worker.calls.at(-1), 'DELETE /v1/me');
});

test('takes nothing under an id that isn’t its key’s, and asks nothing with the link then', async () => {
    const h = await aHome();
    h.worker.faults.anotherId = true;
    const door = h.open();
    await door.arrive();
    const error = await assert.throws(() => door.join(() => {}));
    assert.equal([error instanceof Turned, error.why], [true, 'invalid']);
    assert.ok(!h.worker.calls.some((call) => call.includes('/invites/')), 'no request made');
    assert.equal(await h.store.get(KEPT_KEY), undefined);
});

test('makes a new key pair when the Worker says its key is in use, and is the new key’s camera', async () => {
    const h = await aHome();
    h.worker.faults.keyInUse = 1;
    const door = h.open();
    await door.arrive();
    const { pass } = await approved(h, door);
    const keys = h.worker.bodies.filter((b) => b.call === 'POST /v1/devices').map((b) => b.body.public_key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(pass.cameraId, await cameraIdOf(fromB64url(keys[1])));
});

test('turned down, too old, or not one of ours: says which, and leaves nothing behind', async () => {
    // A member says no.
    const denied = await aHome();
    let door = denied.open();
    await door.arrive();
    const shown = [];
    const joining = door.join((code) => shown.push(code));
    await asked(denied, shown);
    const id = denied.worker.requestOn(denied.invite.id).deviceId;
    denied.worker.denyOn(denied.invite.id);
    let error = await assert.throws(() => joining);
    assert.equal(error.why, 'denied');
    assert.equal([denied.worker.devices.has(id), await denied.store.get(KEPT_KEY)], [false, undefined]);
    // Past its ten minutes before it asked.
    const old = await aHome({ invite: { lastsMs: 1 } });
    await sleep(5);
    door = old.open();
    await door.arrive();
    error = await assert.throws(() => door.join(() => {}));
    assert.equal(error.why, 'expired');
    // A token that isn't the invite's: a link that was never one of ours.
    const forged = await aHome();
    const link = `${PAGE}#${b64url(new TextEncoder().encode(JSON.stringify({ v: 3, i: forged.invite.id, t: b64url(new Uint8Array(32).fill(9)) })))}`;
    door = forged.open(link);
    await door.arrive();
    error = await assert.throws(() => door.join(() => {}));
    assert.equal(error.why, 'invalid');
    assert.equal(await forged.store.get(KEPT_KEY), undefined);
    // An invite the Worker never heard of.
    const gone = await aHome();
    gone.worker.invites.delete(gone.invite.id);
    door = gone.open();
    await door.arrive();
    error = await assert.throws(() => door.join(() => {}));
    assert.equal(error.why, 'expired');
});

test('takes no pass the contract refuses, and leaves nothing behind for one', async () => {
    const day = 86_400_000;
    const cases = [
        ['a MAC that its link’s token never made', { change: (listed) => ({ ...listed, approval_mac: b64url(new Uint8Array(32).fill(1)) }) }, 'invalid'],
        ['no MAC at all', { change: (listed) => ({ ...listed, approval_mac: null }) }, 'invalid'],
        ['listed as from another key', { change: (listed) => ({ ...listed, from_public_key: b64url(fromB64url(listed.from_public_key).map((b, i) => (i === 64 ? b ^ 1 : b))) }) }, 'invalid'],
        ['another pass in its place', { change: (listed) => ({ ...listed, pass: `${listed.pass.split('.')[0]}.${b64url(new Uint8Array(80))}` }) }, 'invalid'],
        ['an epoch inside that isn’t the one it was wrapped as', { inside: (pass) => ({ ...pass, epoch: pass.epoch + 1 }) }, 'invalid'],
        ['inside, not a pass', { inside: () => ({ householdID: 'x', epochs: [] }) }, 'invalid'],
        ['a latest end more than a week from its start', { inside: (pass) => ({ ...pass, latest_end: pass.started_at + 7 * day + 1 }) }, 'invalid'],
        ['already past its end', { startedAt: Date.now() - 2 * day, endsAt: Date.now() - day, latestEnd: Date.now() }, 'expired'],
    ];
    for (const [what, how, why] of cases) {
        const h = await aHome();
        const door = h.open();
        await door.arrive();
        const shown = [];
        const joining = door.join((code) => shown.push(code));
        await asked(h, shown);
        const id = h.worker.requestOn(h.invite.id).deviceId;
        await h.worker.approveOn(h.invite.id, how);
        const error = await assert.throws(() => joining, what);
        assert.equal([error instanceof Turned, error.why], [true, why], what);
        assert.equal([h.worker.devices.has(id), await h.store.get(KEPT_KEY)], [false, undefined], `${what}: nothing left behind`);
    }
    // The Worker says the page is in another household than the one the pass was made for.
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    h.worker.faults.listedIn = (await h.worker.home()).id;
    const error = await assert.throws(() => approved(h, door));
    assert.equal(error.why, 'invalid');
});

test('waits for a Worker it can’t reach, and gives up once the invite surely has', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    h.worker.faults.unreachable = 3;
    h.worker.faults.noPass = 2;
    const { pass } = await approved(h, door);
    assert.ok(h.worker.devices.has(pass.cameraId));
    // Never reached at all.
    const away = await aHome();
    away.worker.faults.offline = true;
    const lost = new WorkerDoor({ api: away.worker.api, page: PAGE, opened: away.invite.link(PAGE), store: away.store, fetch: away.worker.fetch, WebSocket: away.worker.WebSocket, clock, model: 'Mac', appVersion: 'web (0)', timing: { ...SOON, askForAtMostMs: 300 } });
    await lost.arrive();
    const started = Date.now();
    const error = await assert.throws(() => lost.join(() => {}));
    assert.equal(error.why, 'expired');
    assert.ok(Date.now() - started < 3_000);
    assert.equal(await away.store.get(KEPT_KEY), undefined);
});

test('opens its socket with a one-use ticket each time, and a camera the home ends is gone', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    const { pass } = await approved(h, door);
    const states = [];
    const link = door.connect(pass);
    link.onState = (state) => states.push(state);
    await until(() => link.isOpen, 'the socket to open', 5_000, 5);
    const socket = h.worker.sockets.get(pass.cameraId);
    assert.ok(socket && socket.appVersion === 'web (0)');
    assert.equal(h.worker.tickets.size, 0, 'its ticket is used up');
    // Dropped: it comes back by itself, with a new ticket.
    socket.closedBy(1006);
    await until(() => states.includes('closed') && link.isOpen && h.worker.sockets.get(pass.cameraId) !== socket, 'the socket to come back', 8_000, 20);
    assert.equal(h.worker.calls.filter((call) => call === 'POST /v1/realtime/ticket').length, 2);
    // A ticket used once doesn't open a second socket.
    const replay = new h.worker.WebSocket(h.worker.sockets.get(pass.cameraId).url);
    const refused = await new Promise((resolve) => {
        replay.onclose = (event) => resolve(event.code);
    });
    assert.equal(refused, 1006);
    // Ended by a member: the Worker closes it with 4003, and it is gone for good.
    h.worker.endCamera(pass.cameraId);
    await until(() => states.at(-1) === 'gone', 'the camera to be gone', 5_000, 5);
    link.stop();
});

test('a socket for a device the Worker no longer has is gone, not tried again', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    const { pass } = await approved(h, door);
    h.worker.forgetDevice(pass.cameraId);
    const states = [];
    const link = door.connect(pass);
    link.onState = (state) => states.push(state);
    await until(() => states.includes('gone'), 'the socket to say it is gone', 5_000, 5);
    assert.equal(h.worker.calls.filter((call) => call === 'POST /v1/realtime/ticket').length, 1);
});

test('asks what its plan allows and the Worker’s time, and reads relay hours as the apps do', async () => {
    const h = await aHome({ home: { limits: { liveHeight: 720, relayHeight: 720 }, relaySeconds: 90, clockOffMs: 200_000, iceServers: [{ urls: ['stun:stun.example:3478'] }, { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }] } });
    const door = h.open();
    await door.arrive();
    const { pass } = await approved(h, door);
    const allowance = await door.allowance(pass);
    assert.equal([allowance.limits, allowance.relay], [{ liveHeight: 720, relayHeight: 720 }, true]);
    assert.ok(Math.abs(allowance.serverNow - (Date.now() + 200_000)) < 5_000);
    // Every server the Worker lists, with no field it didn't give.
    assert.equal(await door.iceServers(pass), [{ urls: ['stun:stun.example:3478'] }, { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }]);
    // Reporting relayed time: hours left, then none.
    assert.equal(await door.relayed(pass, 60), { relay: true });
    assert.equal(await door.relayed(pass, 60), { relay: false });
    assert.equal(h.home.relayed, [60, 60]);
    // A report the Worker refuses for good gives null; one that couldn't be made throws, to be made again.
    assert.equal(await door.relayed(pass, 601), null);
    h.worker.faults.offline = true;
    await assert.throws(() => door.relayed(pass, 5));
    h.worker.faults.offline = false;
    // With no plan: no caps, and what it last heard of the relay stands.
    h.worker.setLimits(h.home, null);
    const none = await door.allowance(pass);
    assert.equal([none.limits, none.relay], [null, false]);
});

test('keeps a later end and the commands it carried out, never past its latest end', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    const { pass } = await approved(h, door);
    await door.keep({ ...pass, endsAt: pass.endsAt + 3_600_000 }, { 'a-command': 1767225600000 });
    let arrival = await h.open(PAGE).arrive();
    assert.equal([arrival.pass.endsAt, arrival.seen], [pass.endsAt + 3_600_000, { 'a-command': 1767225600000 }]);
    // An end sooner than the one it has, or past its latest, is held to those.
    await door.keep({ ...pass, endsAt: pass.endsAt - 5 }, {});
    await door.keep({ ...pass, endsAt: pass.latestEndAt + 86_400_000 }, {});
    arrival = await h.open(PAGE).arrive();
    assert.equal(arrival.pass.endsAt, pass.latestEndAt);
});

test('refreshes its session and keeps the new one; a refresh the Worker refuses is the end of it', async () => {
    const h = await aHome();
    h.worker.accessLastsMs = 30_000;
    const door = h.open();
    await door.arrive();
    const { pass } = await approved(h, door);
    const before = (await h.store.get(KEPT_KEY)).session;
    await door.allowance(pass);
    const after = (await h.store.get(KEPT_KEY)).session;
    assert.ok(h.worker.calls.includes('POST /v1/auth/refresh'));
    assert.notEqual(after.accessToken, before.accessToken);
    // Opened again, it uses the session it kept last.
    const again = h.open(PAGE);
    assert.equal((await again.arrive()).kind, 'kept');
    // A session the Worker no longer takes, and can't refresh: gone.
    h.worker.forgetDevice(pass.cameraId);
    assert.equal(await again.stillThere(), 'gone');
});

test('leaves without waiting long on a Worker that doesn’t answer, and keeps nothing', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    await approved(h, door);
    h.worker.faults.hang = true;
    const started = Date.now();
    await door.leave();
    assert.ok(Date.now() - started < 2_000, `left in ${Date.now() - started} ms`);
    assert.equal(await h.store.get(KEPT_KEY), undefined);
    // And nothing it does afterwards keeps anything again.
    await door.keep({ cameraId: 'x', keys: null, endsAt: Date.now() + 1, latestEndAt: Date.now() + 2, startedBy: null }, {});
    assert.equal(await h.store.get(KEPT_KEY), undefined);
});

test('reads back only what it kept itself, and forgets a record that isn’t', async () => {
    const h = await aHome();
    const door = h.open();
    await door.arrive();
    await approved(h, door);
    const good = await h.store.get(KEPT_KEY);
    assert.ok((await readKept(good)) !== null);
    const held = await readKept(good);
    const kept = toKeep(/** @type {any} */ (held));
    const subtle = globalThis.crypto.subtle;
    const readable = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(32).fill(3);
    const readableKeys = [{
        epoch: kept.camera.keys[0].epoch,
        box: await subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']),
        media: await subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']),
        signal: await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']),
    }];
    const asking = { inviteId: kept.camera.inviteId, invite: (await inviteKeys(new Uint8Array(32))).kept(), nonce: new Uint8Array(32), commitment: 'x'.repeat(43), asked: true, memberNonce: null };
    assert.ok((await readKept({ ...kept, camera: null, asking })) !== null, 'a request alone reads');
    const bad = {
        'another version': { ...kept, v: 2 },
        'an id that isn’t its key’s': { ...kept, deviceId: 'c0000000-0000-4000-8000-00000000000c' },
        'a private key that can be read out': { ...kept, deviceKey: { ...kept.deviceKey, privateKey: readable.privateKey } },
        'asking and a camera at once': { ...kept, asking },
        'a request whose keys can’t be its link’s': { ...kept, camera: null, asking: { ...asking, invite: { ...asking.invite, approveKey: asking.invite.proofKey } } },
        'a request with a nonce that isn’t 32 bytes': { ...kept, camera: null, asking: { ...asking, nonce: new Uint8Array(31) } },
        'neither': { ...kept, camera: null },
        'a camera with no session': { ...kept, session: null },
        'an end past its latest': { ...kept, camera: { ...kept.camera, endsAt: kept.camera.latestEndAt + 1 } },
        'longer than a week': { ...kept, camera: { ...kept.camera, latestEndAt: kept.camera.startedAt + 7 * 86_400_000 + 1 } },
        'keys of the home’s kind, two epochs': { ...kept, camera: { ...kept.camera, keys: [...kept.camera.keys, { ...kept.camera.keys[0], epoch: 9 }] } },
        'keys that can be read out': { ...kept, camera: { ...kept.camera, keys: readableKeys } },
        'a list': [kept],
        'nothing': null,
    };
    for (const [what, record] of Object.entries(bad)) assert.equal(await readKept(record), null, what);
    // Opened on a record like that, the page holds nothing, and the record goes.
    await h.store.set(KEPT_KEY, bad['an id that isn’t its key’s']);
    assert.equal(await h.open(PAGE).arrive(), { kind: 'nothing' });
    assert.equal(await h.store.get(KEPT_KEY), undefined);
});
