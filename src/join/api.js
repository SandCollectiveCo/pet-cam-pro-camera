// The Worker's routes a temporary camera calls (docs/API.md, Temporary
// cameras, Its own routes), and no others: registering, its session, asking
// with a camera invite, its own row, its pass, relay addresses, its relayed
// time, the ticket that opens its socket, and deleting itself. Every other
// route answers a `web` device with `403 not_for_web`, so nothing else is
// here to call.
//
// Each answer is read as strictly as the apps read theirs: what doesn't read
// is no answer. It talks to the Worker by the Worker's full address alone,
// sends no cookie, follows no redirect, and keeps nothing: the door keeps
// what has to outlast a reload (src/join/kept.js).

import { readIceServers, readOwnRow } from '../wire/frames.js';
import { Refused, isObject, object, optional, reader, required } from '../wire/read.js';

/** The longest a request waits for its answer. */
export const ANSWER_WITHIN_MS = 20_000;
/** A session is refreshed this long before its access token runs out. */
const REFRESH_AHEAD_MS = 60_000;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/** The most a token the page holds may run to. */
const MAX_TOKEN = 4_096;

/** The Worker said no: its status and its code (`{ "error": "<code>" }`). */
export class WorkerSaid extends Error {
    /** @param {number} status @param {string} code */
    constructor(status, code) {
        super(`the Worker said ${status} ${code}`);
        this.name = 'WorkerSaid';
        this.status = status;
        this.code = code;
    }
}

/** The Worker couldn't be reached, didn't answer in time, was busy (429,
 * 408) or failed (5xx): worth asking again later. */
export class Unreachable extends Error {
    /** @param {string} why */
    constructor(why) {
        super(why);
        this.name = 'Unreachable';
    }
}

/** This device has no session the Worker takes, and can't get one back: it
 * was deleted, ended, or never approved and cleared away. */
export class NoSession extends Error {
    constructor() {
        super('this device has no session the Worker takes');
        this.name = 'NoSession';
    }
}

/** @typedef {import('./kept.js').KeptSession} KeptSession */

/** `Session` (docs/API.md, Sessions), as the page holds one. */
const readSession = reader((json) => {
    const from = object(json, 'a session');
    const session = {
        deviceId: required(from, 'device_id', 'string'),
        accessToken: required(from, 'access_token', 'string'),
        refreshToken: required(from, 'refresh_token', 'string'),
        expiresAt: required(from, 'expires_at', 'int'),
    };
    for (const token of [session.accessToken, session.refreshToken]) if (token === '' || token.length > MAX_TOKEN) throw new Refused('a token');
    return session;
});

/** `POST /v1/devices`'s answer: the device it registered, and its session. */
const readRegistered = reader((json) => {
    const from = object(json, 'the answer');
    const device = object(from.device, 'its device');
    const session = readSession(from.session);
    const id = required(device, 'id', 'string');
    if (!session || session.deviceId !== id) throw new Refused("a session for another device than the one registered");
    return { deviceId: id, session };
});

const STATUSES = Object.freeze(['pending', 'approved', 'denied', 'expired']);

/** A request to join, as the asking device is told of it. A status nobody
 * here knows doesn't read. */
const readRequest = reader((json) => {
    const from = object(json, 'a request');
    const status = required(from, 'status', 'string');
    if (!STATUSES.includes(status)) throw new Refused(`a status: ${status}`);
    const memberNonce = optional(from, 'member_nonce', 'string');
    if (memberNonce !== null && !BASE64URL_32.test(memberNonce)) throw new Refused('a member nonce is 32 bytes');
    return { status: /** @type {'pending' | 'approved' | 'denied' | 'expired'} */ (status), memberNonce };
});

/** `POST /v1/realtime/ticket`'s answer: good for one upgrade, within a minute. */
const readTicket = reader((json) => {
    const from = object(json, 'a ticket');
    const ticket = required(from, 'ticket', 'string');
    if (!BASE64URL_32.test(ticket)) throw new Refused('a ticket is 32 bytes');
    return { ticket, expiresAt: required(from, 'expires_at', 'int') };
});

/**
 * Whether the home has relay hours left, from the Plan a relay report is
 * answered with, read as the apps read it (`Plan.relayAllowed` in Shared/):
 * the free plan has none; with no plan nothing is live, so nothing is held
 * back; otherwise the month's hours less what's used, all back once the
 * month has turned. Null for a Plan that doesn't read.
 * @param {unknown} json @param {number} now
 * @returns {boolean | null}
 */
export function relayLeft(json, now) {
    try {
        const plan = object(json, 'a plan');
        if (plan.free !== undefined && plan.free !== null) return false;
        if (plan.limits === undefined || plan.limits === null) return true;
        const limits = object(plan.limits, 'its limits');
        const usage = object(plan.usage, 'its usage');
        const used = now < required(usage, 'relay_resets_at', 'int') ? required(usage, 'relay_seconds', 'int') : 0;
        return required(limits, 'relay_seconds', 'int') - used > 0;
    } catch (error) {
        if (error instanceof Refused) return null;
        throw error;
    }
}

/**
 * @param {unknown} json @param {number} status
 * @returns {string} the code a refusal names
 */
const codeOf = (json, status) => (isObject(json) && typeof json.error === 'string' && json.error !== '' ? json.error : `http_${status}`);

/** What came back: the status and the JSON, or `undefined` for a body that isn't JSON. */
/** @typedef {{ status: number, json: unknown }} Answer */

export class WorkerApi {
    /**
     * @param {{
     *   api: string,
     *   fetch: (url: string, init: RequestInit) => Promise<Response>,
     *   clock: { now: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void },
     *   session?: KeptSession | null,
     *   deviceId?: string | null,
     *   onSession?: (session: KeptSession) => void,
     *   answerWithinMs?: number,
     * }} options `api` the Worker's address, with no slash at its end; `onSession` hears each session a refresh brings, to keep it
     */
    constructor(options) {
        this.api = options.api.replace(/\/+$/, '');
        this.fetch = options.fetch;
        this.clock = options.clock;
        /** @type {KeptSession | null} */
        this.session = options.session ?? null;
        /** Whose session it is: a session for any other device is none. */
        this.deviceId = options.deviceId ?? null;
        this.onSession = options.onSession ?? (() => {});
        this.answerWithinMs = options.answerWithinMs ?? ANSWER_WITHIN_MS;
        /** @type {Promise<void> | null} */
        this.refreshing = null;
    }

    /** One request, and its answer. Throws `Unreachable` where there was none to read.
     * @param {string} method @param {string} path @param {unknown} [body] @param {string | null} [token] @returns {Promise<Answer>} */
    async send(method, path, body, token = null) {
        const controller = new AbortController();
        const timer = this.clock.setTimeout(() => controller.abort(), this.answerWithinMs);
        try {
            /** @type {Record<string, string>} */
            const headers = {};
            if (token !== null) headers.authorization = `Bearer ${token}`;
            if (body !== undefined) headers['content-type'] = 'application/json';
            const response = await this.fetch(`${this.api}${path}`, {
                method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
                cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
            });
            const text = response.status === 204 ? '' : await response.text();
            let json;
            try {
                json = text === '' ? null : JSON.parse(text);
            } catch {
                json = undefined;
            }
            if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Unreachable(`the Worker answered ${response.status}`);
            return { status: response.status, json };
        } catch (error) {
            if (error instanceof Unreachable) throw error;
            throw new Unreachable(`no answer from the Worker: ${error?.name ?? 'Error'}`);
        } finally {
            this.clock.clearTimeout(timer);
        }
    }

    /** A request under this device's session, refreshed first where it's about to run out, and once more where the Worker turns it away.
     * @param {string} method @param {string} path @param {unknown} [body] @returns {Promise<Answer>} */
    async authed(method, path, body) {
        if (!this.session) throw new NoSession();
        if (this.session.expiresAt - this.clock.now() < REFRESH_AHEAD_MS) await this.refresh();
        let answer = await this.send(method, path, body, /** @type {KeptSession} */ (this.session).accessToken);
        if (answer.status === 401) {
            await this.refresh();
            answer = await this.send(method, path, body, /** @type {KeptSession} */ (this.session).accessToken);
            if (answer.status === 401) throw new NoSession();
        }
        return answer;
    }

    /** A new access token for the refresh token: one refresh at a time, however many ask. */
    refresh() {
        this.refreshing ??= (async () => {
            const held = this.session;
            if (!held) throw new NoSession();
            const answer = await this.send('POST', '/v1/auth/refresh', { refresh_token: held.refreshToken });
            if (answer.status === 401) throw new NoSession();
            if (answer.status !== 200) throw new WorkerSaid(answer.status, codeOf(answer.json, answer.status));
            const session = readSession(answer.json);
            // A session for another device is none of this one's.
            if (!session || (this.deviceId !== null && session.deviceId !== this.deviceId)) throw new NoSession();
            this.session = { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt };
            this.onSession(this.session);
        })().finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    /** @param {Answer} answer @param {number[]} ok @returns {unknown} its JSON */
    static expect(answer, ok) {
        if (ok.includes(answer.status)) return answer.json;
        throw new WorkerSaid(answer.status, codeOf(answer.json, answer.status));
    }

    // ---- Registering ----------------------------------------------------------

    /**
     * Registers this page as a `web` device with its key (`POST /v1/devices`).
     * Gives the id the Worker gave it and its session, which the door holds
     * to its key's before it keeps either. Throws `WorkerSaid` with
     * `key_in_use` for a key that already has a row.
     * @param {{ publicKey: string, model: string, appVersion: string }} device
     */
    async register(device) {
        const answer = await this.send('POST', '/v1/devices', { role: 'camera', platform: 'web', model: device.model, app_version: device.appVersion, public_key: device.publicKey });
        const registered = readRegistered(WorkerApi.expect(answer, [200, 201]));
        if (!registered) throw new WorkerSaid(answer.status, 'unreadable');
        return registered;
    }

    /** Holds a session from here on, for this device. @param {string} deviceId @param {KeptSession} session */
    use(deviceId, session) {
        this.deviceId = deviceId;
        this.session = session;
    }

    // ---- Asking with a camera invite -----------------------------------------

    /** `POST /v1/invites/:id/requests`. @param {string} inviteId @param {{ token_check: string, public_key: string, proof: string, nonce_commitment: string }} body */
    async ask(inviteId, body) {
        const read = readRequest(WorkerApi.expect(await this.authed('POST', `/v1/invites/${inviteId}/requests`, body), [200, 201]));
        if (!read) throw new WorkerSaid(201, 'unreadable');
        return read;
    }

    /** `GET /v1/invites/:id/requests/me`: how its request stands. @param {string} inviteId */
    async request(inviteId) {
        const read = readRequest(WorkerApi.expect(await this.authed('GET', `/v1/invites/${inviteId}/requests/me`), [200]));
        if (!read) throw new WorkerSaid(200, 'unreadable');
        return read;
    }

    /** `POST /v1/invites/:id/requests/me/reveal`. @param {string} inviteId @param {string} joinerNonce base64url */
    async reveal(inviteId, joinerNonce) {
        WorkerApi.expect(await this.authed('POST', `/v1/invites/${inviteId}/requests/me/reveal`, { joiner_nonce: joinerNonce }), [200, 204]);
    }

    /** `DELETE /v1/invites/:id/requests/me`: its request withdrawn. @param {string} inviteId */
    async withdraw(inviteId) {
        WorkerApi.expect(await this.authed('DELETE', `/v1/invites/${inviteId}/requests/me`), [200, 204]);
    }

    // ---- Once it's in ---------------------------------------------------------

    /** `GET /v1/me`: its own row, the caps its plan sets, and the Worker's clock. */
    async me() {
        const read = readOwnRow(WorkerApi.expect(await this.authed('GET', '/v1/me'), [200]));
        if (!read) throw new WorkerSaid(200, 'unreadable');
        return read;
    }

    /** `GET /v1/me/pass`: the pass as listed, for the door to hold to its order, or null before there is one (`404 no_pass`). */
    async pass() {
        const answer = await this.authed('GET', '/v1/me/pass');
        if (answer.status === 404 && codeOf(answer.json, 404) === 'no_pass') return null;
        return WorkerApi.expect(answer, [200]);
    }

    /** `GET /v1/ice-servers`: the relay addresses under the home's plan. Throws `WorkerSaid` (402) without one. */
    async iceServers() {
        const read = readIceServers(WorkerApi.expect(await this.authed('GET', '/v1/ice-servers'), [200]));
        if (!read) throw new WorkerSaid(200, 'unreadable');
        return read;
    }

    /** `POST /v1/household/relay`: the seconds it relayed since its last report. Gives whether the home has relay hours left, or null for a Plan that doesn't read.
     * @param {number} seconds 1 to 600 */
    async relayed(seconds) {
        return relayLeft(WorkerApi.expect(await this.authed('POST', '/v1/household/relay', { seconds }), [200]), this.clock.now());
    }

    /** `POST /v1/realtime/ticket`: one use, within a minute, in a header's place. */
    async ticket() {
        const read = readTicket(WorkerApi.expect(await this.authed('POST', '/v1/realtime/ticket'), [200, 201]));
        if (!read) throw new WorkerSaid(200, 'unreadable');
        return read;
    }

    /** Where its socket opens, with a ticket: `GET /v1/realtime?ticket=…&app_version=…`.
     * @param {string} ticket @param {string} appVersion */
    socketAddress(ticket, appVersion) {
        const url = new URL(`${this.api}/v1/realtime`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket);
        url.searchParams.set('app_version', appVersion);
        return url.href;
    }

    /** `DELETE /v1/me`: this device, and what the Worker holds of it. */
    async deleteMe() {
        WorkerApi.expect(await this.authed('DELETE', '/v1/me'), [200, 204]);
    }
}
