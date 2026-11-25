// A stand-in for the Worker, in memory, for the door's tests (src/join/
// worker-door.js): the routes a temporary camera calls, answered as
// docs/API.md writes them (Temporary cameras, Its own routes), and its
// socket by a one-use ticket, carried by the stand-in socket in dev/relay.js.
//
// It also plays a home's member from the other side: it makes a camera
// invite, answers a request, works out the code a member shows, and
// approves with a pass wrapped for the page's key and the approval's MAC,
// made as an app makes them. Everything a member holds here (a device key,
// a camera's secret) is made up for the test and was never anyone's: there
// is no home's key anywhere in it, since a page never sees one.
//
// A test can have it misbehave, to see the door refuse: give an id that
// isn't the page's key's, say a key is in use, fail to answer, list the
// page in another household, hand over a pass that isn't vouched for.

import { b64url, fromB64url } from '../src/crypto/bytes.js';
import { PASS_INFO, hpkeSeal, passAad } from '../src/crypto/hpke.js';
import { inviteKeys, inviteTokenHash, nonceCommitment, nonceCommitmentWithKey } from '../src/crypto/invite.js';
import { KeySet } from '../src/crypto/keys.js';
import { generateDeviceKey } from '../src/crypto/p256.js';
import { derivationKey, deriveMacKey, hmacWith, randomBytes, randomId } from '../src/crypto/primitives.js';
import { cameraIdOf } from '../src/join/id.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/** The routes a `web` device may call: anything else is `403 not_for_web`. */
const WEB_ROUTES = [
    /^POST \/v1\/devices$/, /^POST \/v1\/auth\/refresh$/, /^(POST|DELETE) \/v1\/invites\/[^/]+\/requests(\/me)?$/, /^GET \/v1\/invites\/[^/]+\/requests\/me$/,
    /^POST \/v1\/invites\/[^/]+\/requests\/me\/reveal$/, /^(GET|DELETE) \/v1\/me$/, /^GET \/v1\/me\/pass$/, /^GET \/v1\/ice-servers$/, /^POST \/v1\/household\/relay$/,
    /^POST \/v1\/realtime\/ticket$/,
];

/** A refusal, as the Worker writes one. */
class Said extends Error {
    /** @param {number} status @param {string} code */
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

/** @param {unknown} key */
function isPublicKey(key) {
    if (typeof key !== 'string') return false;
    try {
        const bytes = fromB64url(key);
        return bytes.length === 65 && bytes[0] === 0x04;
    } catch {
        return false;
    }
}

/** @param {number} status @param {unknown} [body] */
const respond = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/json' } });

export class StandInWorker {
    /**
     * @param {{ api?: string, relay?: import('./relay.js').Relay | null, now?: () => number }} [options] `relay` carries the sockets' frames between devices
     */
    constructor(options = {}) {
        this.api = options.api ?? 'https://worker.test';
        this.relay = options.relay ?? null;
        this.now = options.now ?? (() => Date.now());
        /** @type {Map<string, any>} */
        this.devices = new Map();
        /** access token → { deviceId, expiresAt } */
        this.access = new Map();
        /** refresh token → device id */
        this.refreshing = new Map();
        /** @type {Map<string, any>} */
        this.invites = new Map();
        /** device id → the pass as listed */
        this.passes = new Map();
        /** @type {Map<string, any>} */
        this.homes = new Map();
        /** ticket → { deviceId, expiresAt } */
        this.tickets = new Map();
        /** device id → its open socket */
        this.sockets = new Map();
        /** Every call it was asked, as "METHOD path", in order. */
        this.calls = [];
        /** Every body it was sent, by "METHOD path". */
        this.bodies = [];
        /** How long an access token lasts. */
        this.accessLastsMs = HOUR_MS;
        /**
         * What a test has it do wrong. `unreachable`: the next n calls get no answer at all. `keyInUse`: the next n
         * registrations are `409 key_in_use`. `anotherId`: registering gives an id that isn't the key's. `listedIn`:
         * GET /v1/me names this household. `noPass`: GET /v1/me/pass says `no_pass` n more times. `offline`: every call
         * gets no answer while it's true. `hang`: every call waits for an answer that never comes, until it's given up on.
         */
        this.faults = { unreachable: 0, keyInUse: 0, anotherId: false, listedIn: /** @type {string | null} */ (null), noPass: 0, offline: false, hang: false };
        this.fetch = (url, init) => this.answer(url, init);
        const worker = this;
        /** The page's socket, opened by a ticket. */
        this.WebSocket = class StandInSocket {
            /** @param {string} url */
            constructor(url) {
                this.url = url;
                this.binaryType = 'blob';
                this.readyState = 0;
                this.onopen = null;
                this.onmessage = null;
                this.onclose = null;
                this.onerror = null;
                this.deviceId = null;
                setTimeout(() => worker.upgrade(this), 0);
            }

            /** @param {string | Uint8Array | ArrayBuffer} data */
            send(data) {
                if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError');
                if (data === 'ping') {
                    setTimeout(() => this.onmessage?.({ data: 'pong' }), 0);
                    return;
                }
                if (typeof data === 'string') worker.relay?.take(/** @type {string} */ (this.deviceId), data);
                else worker.relay?.takeBinary(/** @type {string} */ (this.deviceId), data instanceof Uint8Array ? data : new Uint8Array(data));
            }

            close() {
                if (this.readyState === 3) return;
                this.readyState = 3;
                worker.dropSocket(this);
            }

            /** The Worker closes it. @param {number} code */
            closedBy(code) {
                if (this.readyState === 3) return;
                this.readyState = 3;
                worker.dropSocket(this);
                setTimeout(() => this.onclose?.({ code, reason: '', wasClean: true }), 0);
            }
        };
    }

    // ---- The routes ---------------------------------------------------------

    /** @param {string} url @param {RequestInit} [init] @returns {Promise<Response>} */
    async answer(url, init = {}) {
        const method = init.method ?? 'GET';
        const where = new URL(url);
        if (`${where.protocol}//${where.host}` !== this.api) throw new TypeError('Failed to fetch');
        const path = where.pathname;
        this.calls.push(`${method} ${path}`);
        if (this.faults.hang) {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
            });
        }
        if (this.faults.offline || this.faults.unreachable > 0) {
            if (this.faults.unreachable > 0) this.faults.unreachable -= 1;
            throw new TypeError('Failed to fetch');
        }
        const headers = new Headers(init.headers ?? {});
        let body = null;
        if (typeof init.body === 'string') {
            try {
                body = JSON.parse(init.body);
            } catch {
                return respond(400, { error: 'invalid_request', message: 'not JSON' });
            }
        }
        this.bodies.push({ call: `${method} ${path}`, body });
        try {
            return await this.route(method, path, body, headers, where);
        } catch (error) {
            if (error instanceof Said) return respond(error.status, { error: error.code, message: error.code });
            throw error;
        }
    }

    /** @param {Headers} headers */
    caller(headers) {
        const token = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
        const held = token ? this.access.get(token) : undefined;
        if (!held || held.expiresAt <= this.now() || !this.devices.has(held.deviceId)) throw new Said(401, 'unauthorized');
        return this.devices.get(held.deviceId);
    }

    /** @param {string} deviceId */
    session(deviceId) {
        const accessToken = b64url(randomBytes(24));
        const refreshToken = b64url(randomBytes(32));
        const expiresAt = this.now() + this.accessLastsMs;
        this.access.set(accessToken, { deviceId, expiresAt });
        this.refreshing.set(refreshToken, deviceId);
        return { device_id: deviceId, access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt };
    }

    /** A Device, as the Worker writes one: for a `web` device, its mark carries its end alone, never its entry. @param {any} device */
    row(device) {
        return {
            id: device.id, name: null, role: device.role, platform: device.platform, model: device.model, household_id: device.householdId,
            created_at: device.createdAt, last_seen_at: null, online: this.sockets.has(device.id), status: null, prefs: { notify_offline: true, muted_cameras: [] },
            alert_prefs: null, public_key: device.publicKey, key_attestation: null, key_epoch: null, account: null, person: null,
            ...(device.endsAt !== null ? { temporary: { ends_at: device.endsAt } } : {}),
        };
    }

    /** @param {string} method @param {string} path @param {any} body @param {Headers} headers @param {URL} where */
    async route(method, path, body, headers, where) {
        const call = `${method} ${path}`;
        if (call === 'POST /v1/devices') return this.register(body);
        if (call === 'POST /v1/auth/refresh') {
            const deviceId = this.refreshing.get(body?.refresh_token);
            if (!deviceId || !this.devices.has(deviceId)) throw new Said(401, 'invalid_refresh_token');
            return respond(200, this.session(deviceId));
        }
        const device = this.caller(headers);
        if (device.platform === 'web' && !WEB_ROUTES.some((route) => route.test(call))) throw new Said(403, 'not_for_web');
        const asked = /^\/v1\/invites\/([^/]+)\/requests(\/me(\/reveal)?)?$/.exec(path);
        if (asked) return this.request(method, asked[1], asked[2] !== undefined, asked[3] !== undefined, device, body);
        const home = device.householdId ? this.homes.get(device.householdId) : null;
        switch (call) {
            case 'GET /v1/me':
                return respond(200, {
                    device: { ...this.row(device), household_id: this.faults.listedIn ?? device.householdId },
                    limits: home?.limits ? { live_height: home.limits.liveHeight, relay_height: home.limits.relayHeight } : null,
                    now: this.now() + (home?.clockOffMs ?? 0),
                });
            case 'GET /v1/me/pass': {
                const listed = this.passes.get(device.id);
                if (!listed || this.faults.noPass > 0) {
                    if (this.faults.noPass > 0) this.faults.noPass -= 1;
                    throw new Said(404, 'no_pass');
                }
                return respond(200, listed);
            }
            case 'GET /v1/ice-servers':
                if (!home) throw new Said(403, 'no_household');
                if (!home.limits) throw new Said(402, 'plan_required');
                return respond(200, { ice_servers: home.iceServers, expires_at: this.now() + 24 * HOUR_MS, relay: home.relayLeft > 0 });
            case 'POST /v1/household/relay': {
                if (!home) throw new Said(403, 'no_household');
                if (device.role !== 'camera') throw new Said(403, 'not_a_camera');
                const seconds = body?.seconds;
                if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Said(400, 'invalid_request');
                home.relayed.push(seconds);
                home.relayLeft -= seconds;
                return respond(200, this.plan(home));
            }
            case 'POST /v1/realtime/ticket': {
                if (!device.householdId) throw new Said(403, 'no_household');
                const ticket = b64url(randomBytes(32));
                this.tickets.set(ticket, { deviceId: device.id, expiresAt: this.now() + 60_000 });
                return respond(200, { ticket, expires_at: this.now() + 60_000 });
            }
            case 'DELETE /v1/me':
                this.forgetDevice(device.id);
                return respond(204);
            default:
                throw new Said(404, 'not_found');
        }
    }

    /** POST /v1/devices. @param {any} body */
    async register(body) {
        if (body?.platform !== 'web') throw new Said(400, 'invalid_request');
        if (body.role !== 'camera' || !isPublicKey(body.public_key) || typeof body.model !== 'string' || body.model.length > 64 || typeof body.app_version !== 'string') throw new Said(400, 'invalid_request');
        // A `web` device's id is its key's, never the Worker's pick: unless a test has it lie.
        const id = this.faults.anotherId ? randomId() : await cameraIdOf(fromB64url(body.public_key));
        if (this.faults.keyInUse > 0 || this.devices.has(id)) {
            if (this.faults.keyInUse > 0) this.faults.keyInUse -= 1;
            throw new Said(409, 'key_in_use');
        }
        const device = { id, platform: 'web', role: 'camera', model: body.model, appVersion: body.app_version, publicKey: body.public_key, householdId: null, endsAt: null, createdAt: this.now() };
        this.devices.set(id, device);
        return respond(201, { device: this.row(device), session: this.session(id) });
    }

    /** The routes of a request to join with an invite. @param {string} method @param {string} inviteId @param {boolean} me @param {boolean} reveal @param {any} device @param {any} body */
    async request(method, inviteId, me, reveal, device, body) {
        const invite = UUID.test(inviteId) ? this.invites.get(inviteId) : undefined;
        if (method === 'POST' && !me) {
            if (!BASE64URL_32.test(body?.token_check ?? '') || !isPublicKey(body?.public_key) || typeof body?.proof !== 'string' || !BASE64URL_32.test(body?.nonce_commitment ?? '')) throw new Said(400, 'invalid_request');
            if (!invite) throw new Said(404, 'invite_not_found');
            if (invite.usedAt !== null || invite.expiresAt <= this.now()) throw new Said(410, 'invite_expired');
            if (body.token_check !== invite.tokenHash) throw new Said(403, 'invalid_invite');
            // A `web` device asks only on a camera invite, and with its own row's key.
            if (device.platform === 'web' && invite.kind !== 'camera') throw new Said(403, 'invalid_invite');
            if (body.public_key !== device.publicKey) throw new Said(400, 'invalid_request');
            const held = invite.requests.get(device.id);
            if (held && held.status === 'pending' && held.publicKey !== body.public_key) throw new Said(409, 'commitment_reused');
            if (!held || held.status === 'pending') {
                invite.requests.set(device.id, { deviceId: device.id, publicKey: body.public_key, proof: body.proof, commitment: body.nonce_commitment, memberNonce: null, joinerNonce: null, status: 'pending', asks: (held?.asks ?? 0) + 1 });
            }
            return respond(201, { status: invite.requests.get(device.id).status });
        }
        const request = invite?.requests.get(device.id);
        if (method === 'GET' && me && !reveal) {
            if (!request) throw new Said(404, 'request_not_found');
            if (request.status === 'pending' && (invite.usedAt !== null || invite.expiresAt <= this.now())) return respond(200, { status: 'expired' });
            return respond(200, request.status === 'pending' && request.memberNonce ? { status: 'pending', member_nonce: request.memberNonce } : { status: request.status });
        }
        if (method === 'POST' && reveal) {
            if (!BASE64URL_32.test(body?.joiner_nonce ?? '')) throw new Said(400, 'invalid_request');
            if (!invite) throw new Said(404, 'invite_not_found');
            if (invite.usedAt !== null || invite.expiresAt <= this.now()) throw new Said(410, 'invite_expired');
            if (!request || request.status !== 'pending') throw new Said(404, 'request_not_found');
            if (!request.memberNonce) throw new Said(409, 'not_answered');
            const nonce = fromB64url(body.joiner_nonce);
            const committed = (await nonceCommitment(nonce)) === request.commitment || (await nonceCommitmentWithKey(nonce, request.publicKey)) === request.commitment;
            if (!committed) throw new Said(400, 'nonce_mismatch');
            request.joinerNonce = body.joiner_nonce;
            return respond(204);
        }
        if (method === 'DELETE' && me) {
            if (request?.status === 'pending') invite.requests.delete(device.id);
            return respond(204);
        }
        throw new Said(404, 'not_found');
    }

    /** The home's Plan, as a relay report is answered. @param {any} home */
    plan(home) {
        const used = home.relaySeconds - Math.max(home.relayLeft, 0);
        return {
            plan: home.limits ? 'premium' : null, status: home.limits ? 'active' : 'none', source: home.limits ? 'comp' : null, expires_at: null, renews_as: null, sandbox: false,
            app_account_token: home.token,
            limits: home.limits ? { cameras: 4, clip_playback: true, retention_days: 14, storage_bytes: 26843545600, live_height: home.limits.liveHeight, relay_seconds: home.relaySeconds, relay_height: home.limits.relayHeight } : null,
            free: null,
            usage: { cameras: 1, storage_bytes: 0, relay_seconds: used, relay_resets_at: this.now() + 30 * DAY_MS },
            covered_cameras: [],
        };
    }

    // ---- The socket ---------------------------------------------------------

    /** A socket opening: its ticket, used once and within a minute. @param {any} socket */
    upgrade(socket) {
        const where = new URL(socket.url);
        const expected = new URL(this.api);
        const ticket = where.searchParams.get('ticket') ?? '';
        const held = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        const fine = where.protocol === (expected.protocol === 'https:' ? 'wss:' : 'ws:') && where.host === expected.host && where.pathname === '/v1/realtime'
            && held && held.expiresAt > this.now() && this.devices.has(held.deviceId) && !this.faults.offline;
        if (!fine) {
            // Refused at the upgrade: a browser sees an error, then a close it can't read.
            socket.readyState = 3;
            socket.onerror?.({});
            socket.onclose?.({ code: 1006, reason: '', wasClean: false });
            return;
        }
        socket.deviceId = held.deviceId;
        socket.appVersion = where.searchParams.get('app_version');
        // Another socket of the same device is replaced.
        this.sockets.get(held.deviceId)?.closedBy(4001);
        this.sockets.set(held.deviceId, socket);
        if (this.relay) {
            const link = this.relay.join(held.deviceId);
            link.onText = (text) => {
                if (socket.readyState === 1) socket.onmessage?.({ data: text });
            };
            socket.link = link;
        }
        socket.readyState = 1;
        socket.onopen?.({});
    }

    /** @param {any} socket */
    dropSocket(socket) {
        if (socket.deviceId && this.sockets.get(socket.deviceId) === socket) {
            this.sockets.delete(socket.deviceId);
            this.relay?.leave(socket.deviceId);
        }
    }

    /** A frame from the Worker itself to a device's socket (`limits_changed`, an `error`). @param {string} deviceId @param {unknown} frame */
    say(deviceId, frame) {
        const socket = this.sockets.get(deviceId);
        if (socket?.readyState === 1) setTimeout(() => socket.onmessage?.({ data: JSON.stringify(frame) }), 0);
    }

    /** @param {string} deviceId */
    forgetDevice(deviceId) {
        this.devices.delete(deviceId);
        this.passes.delete(deviceId);
        for (const [token, held] of this.access) if (held.deviceId === deviceId) this.access.delete(token);
        for (const [token, held] of this.refreshing) if (held === deviceId) this.refreshing.delete(token);
        this.sockets.get(deviceId)?.closedBy(4003);
    }

    // ---- A home's member, from the other side ---------------------------------

    /**
     * A home, and a member device of it whose key wraps the passes.
     * @param {{ limits?: { liveHeight: number, relayHeight: number } | null, relaySeconds?: number, iceServers?: { urls: string[], username?: string, credential?: string }[], clockOffMs?: number }} [how]
     */
    async home(how = {}) {
        const home = {
            id: randomId(), token: randomId(), epoch: 1, member: { id: randomId(), key: await generateDeviceKey() },
            limits: how.limits === undefined ? { liveHeight: 1080, relayHeight: 720 } : how.limits,
            relaySeconds: how.relaySeconds ?? 36_000, relayLeft: how.relaySeconds ?? 36_000, relayed: [],
            iceServers: how.iceServers ?? [{ urls: ['stun:stun.cloudflare.com:3478'] }], clockOffMs: how.clockOffMs ?? 0,
        };
        this.homes.set(home.id, home);
        return home;
    }

    /** A camera invite, good for ten minutes, and its link for a page at `page`. @param {any} home @param {{ lastsMs?: number }} [how] */
    cameraInvite(home, how = {}) {
        const id = randomId();
        const token = randomBytes(32);
        const invite = { id, home, kind: 'camera', tokenHash: '', expiresAt: this.now() + (how.lastsMs ?? 600_000), usedAt: null, requests: new Map(), token };
        this.invites.set(id, invite);
        const ready = inviteTokenHash(token).then((hash) => {
            invite.tokenHash = hash;
        });
        return {
            id, token, ready,
            /** @param {string} page */
            link: (page) => `${page}#${b64url(new TextEncoder().encode(JSON.stringify({ v: 3, i: id, t: b64url(token) })))}`,
        };
    }

    /** The one request on an invite. @param {string} inviteId */
    requestOn(inviteId) {
        const [request] = this.invites.get(inviteId)?.requests.values() ?? [];
        return request ?? null;
    }

    /** A member answers a request with a nonce of its own. @param {string} inviteId */
    answerOn(inviteId) {
        const request = this.requestOn(inviteId);
        if (!request || request.memberNonce) return;
        request.memberNonce = b64url(randomBytes(32));
    }

    /** The code a member shows for the request on an invite, once its nonce is revealed: null before. Shown only for a request whose id is its key's. @param {string} inviteId */
    async codeOn(inviteId) {
        const invite = this.invites.get(inviteId);
        const request = this.requestOn(inviteId);
        if (!invite || !request?.memberNonce || !request.joinerNonce) return null;
        if (request.deviceId !== (await cameraIdOf(fromB64url(request.publicKey)))) return null;
        const keys = await inviteKeys(Uint8Array.from(invite.token));
        return keys.code(invite.id, request.publicKey, fromB64url(request.joinerNonce), request.memberNonce);
    }

    /**
     * A member approves the request on an invite: a camera's secret drawn,
     * the pass wrapped for the page's key from the member's, and the
     * approval's MAC under the link's token. Gives the camera's keys as a
     * member holds them, for a stand-in viewer.
     * @param {string} inviteId
     * @param {{ secret?: Uint8Array, startedAt?: number, endsAt?: number, latestEnd?: number, name?: string | null, epoch?: number, change?: (listed: any) => any, inside?: (pass: any) => any }} [how] `change` and `inside` alter what's listed and what's wrapped, for a test of what the page refuses
     */
    async approveOn(inviteId, how = {}) {
        const invite = this.invites.get(inviteId);
        const request = this.requestOn(inviteId);
        if (!invite || !request) throw new Error('nothing to approve');
        const home = invite.home;
        const secret = how.secret ?? randomBytes(32);
        const epoch = how.epoch ?? home.epoch;
        const startedAt = how.startedAt ?? this.now();
        const endsAt = how.endsAt ?? startedAt + DAY_MS;
        const latestEnd = how.latestEnd ?? startedAt + 7 * DAY_MS;
        let inside = { secret: b64url(secret), epoch, started_at: startedAt, ends_at: endsAt, latest_end: latestEnd, ...(how.name === null ? {} : { started_by_name: how.name ?? 'Maya Lopez' }) };
        if (how.inside) inside = how.inside(inside);
        const pass = await hpkeSeal({
            mode: 'auth', recipientPublicKey: fromB64url(request.publicKey), sender: home.member.key,
            info: PASS_INFO, aad: passAad(home.id, request.deviceId, epoch), plaintext: JSON.stringify(inside),
        });
        const approver = b64url(home.member.key.publicKey);
        const approve = await deriveMacKey(await derivationKey(Uint8Array.from(invite.token)), 'petcam.invite.approve.v1', ['sign']);
        const mac = b64url(await hmacWith(approve, `${invite.id}|${request.deviceId}|${epoch}|${approver}|${pass}`));
        let listed = { epoch, from_device_id: home.member.id, from_public_key: approver, pass, approval_mac: mac, created_at: this.now() };
        if (how.change) listed = how.change(listed);
        this.passes.set(request.deviceId, listed);
        request.status = 'approved';
        invite.usedAt = this.now();
        const device = this.devices.get(request.deviceId);
        if (device) {
            device.householdId = home.id;
            device.endsAt = endsAt;
        }
        return KeySet.fromSecrets({ [epoch]: Uint8Array.from(secret) }, { ofACamera: true });
    }

    /** A member says no. @param {string} inviteId */
    denyOn(inviteId) {
        const request = this.requestOn(inviteId);
        if (request) request.status = 'denied';
    }

    /** A member ends a temporary camera (`DELETE /v1/household/temporary-cameras/:id`): its row goes, and its socket closes with 4003. @param {string} deviceId */
    endCamera(deviceId) {
        this.forgetDevice(deviceId);
    }

    /** The home's plan runs out, comes back, or changes its caps, and its temporary camera hears it. @param {any} home @param {{ liveHeight: number, relayHeight: number } | null} limits */
    setLimits(home, limits) {
        home.limits = limits;
        for (const device of this.devices.values()) {
            if (device.householdId === home.id) this.say(device.id, { type: 'limits_changed', limits: limits ? { live_height: limits.liveHeight, relay_height: limits.relayHeight } : null });
        }
    }
}
