// The door into a home, through the Worker (docs/API.md, Temporary cameras;
// docs/WEB-CAMERA.md § 3): the one a release's page uses.
//
//   1. The link, read from the page's own address (src/join/link.js), whose
//      fragment the page's entry has already taken out of the address. The
//      token becomes keys at once and is wiped: no token is ever kept.
//   2. A key pair the browser makes and won't read out, and the id it makes
//      (src/join/id.js). The page registers as a `web` camera with that key
//      and takes the answer only if the Worker gave it that id.
//   3. It asks with the invite as any device does: its proof, a commitment
//      to a nonce, the nonce revealed once a member has answered, and the
//      six digits both devices show.
//   4. Approved, it takes its pass in the contract's order (src/join/
//      pass.js), keeps the keys it gives, and forgets the secret.
//   5. Its socket opens with a one-use ticket in the bearer token's place;
//      it asks its row what its plan allows and the Worker's time, asks for
//      relay addresses, reports what it relayed, and deletes itself at its
//      end.
//
// What has to outlast a reload is kept as one record (src/join/kept.js):
// asking, it carries on with the same request; a camera, it carries on as
// that camera while its time lasts, unless the home ended it meanwhile.

import { Gone, SocketLink } from '../camera/link.js';
import { b64url } from '../crypto/bytes.js';
import { inviteKeys, nonceCommitment } from '../crypto/invite.js';
import { generateDeviceKey } from '../crypto/p256.js';
import { randomBytes } from '../crypto/primitives.js';
import { ANSWER_WITHIN_MS, NoSession, Unreachable, WorkerApi, WorkerSaid } from './api.js';
import { Turned, goneBecause } from './door.js';
import { cameraIdOf } from './id.js';
import { KEPT_KEY, readKept, toKeep } from './kept.js';
import { readCameraInviteLink } from './link.js';
import { takePass } from './pass.js';

/** How often a request is asked after. */
export const ASK_EVERY_MS = 2_000;
/** The longest it waits between asks while the Worker can't be reached. */
const ASK_AT_MOST_EVERY_MS = 15_000;
/** A camera invite is good for ten minutes: past this, a request is over whatever happened to it. */
export const ASK_FOR_AT_MOST_MS = 15 * 60_000;
/** The longest its end waits on the Worker before it says it's over. */
export const LEAVE_WAITS_MS = 3_000;
/** Relay addresses are asked for again once less than this is left of them, as the apps do. */
const ICE_ASK_AGAIN_MS = 60 * 60_000;
/** How many times a pass is looked for once the request says it's approved. */
const PASS_LOOKS = 10;
/** How many new key pairs it makes when the Worker says a key is in use. */
const NEW_KEYS_AT_MOST = 2;

/**
 * @typedef {object} DoorOptions
 * @property {string} api the Worker's address (src/config.js, `API`)
 * @property {string} page the page's own address, as a link starts with it (src/config.js, `PAGE`)
 * @property {string} opened the address the page was opened at, read once
 * @property {import('../crypto/store.js').Store} store where it keeps what outlasts a reload
 * @property {(url: string, init: RequestInit) => Promise<Response>} fetch
 * @property {new (url: string) => WebSocket} WebSocket
 * @property {{ now: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void }} clock
 * @property {string} model what it registers as: one of the eight words (src/device.js)
 * @property {string} appVersion "web (1)"
 * @property {Partial<Timing>} [timing] a test's alone: the same steps, sooner
 */

/**
 * @typedef {{ askEveryMs: number, askAtMostEveryMs: number, askForAtMostMs: number, leaveWaitsMs: number, answerWithinMs: number }} Timing
 */

/** @param {DoorOptions} options @returns {import('./door.js').Door} */
export function workerDoor(options) {
    return new WorkerDoor(options);
}

export class WorkerDoor {
    /** @param {DoorOptions} options */
    constructor(options) {
        this.options = options;
        this.clock = options.clock;
        /** @type {Timing} */
        this.timing = { askEveryMs: ASK_EVERY_MS, askAtMostEveryMs: ASK_AT_MOST_EVERY_MS, askForAtMostMs: ASK_FOR_AT_MOST_MS, leaveWaitsMs: LEAVE_WAITS_MS, answerWithinMs: ANSWER_WITHIN_MS, ...options.timing };
        this.api = new WorkerApi({ api: options.api, fetch: options.fetch, clock: options.clock, onSession: (session) => this.sessionChanged(session), answerWithinMs: this.timing.answerWithinMs });
        /** The link it was opened with, until `arrive` reads it. */
        this.opened = readCameraInviteLink(options.opened, options.page);
        /** A link, read, for a page that holds nothing yet. @type {{ inviteId: string, invite: Awaited<ReturnType<typeof inviteKeys>> } | null} */
        this.link = null;
        /** @type {import('./kept.js').Held | null} */
        this.held = null;
        /** The last relay addresses it was given. @type {Awaited<ReturnType<WorkerApi['iceServers']>> | null} */
        this.ice = null;
        /** Whether the home has relay hours left, as last said. */
        this.relay = true;
        this.leaving = false;
        /** @type {Promise<void> | null} */
        this.left = null;
    }

    // ---- What this visit is ------------------------------------------------

    /** @returns {Promise<import('./door.js').Arrival>} */
    async arrive() {
        const opened = this.opened;
        this.opened = null;
        // The token becomes keys, and is wiped: the page holds no token.
        const link = opened ? { inviteId: opened.inviteId, invite: await inviteKeys(opened.token) } : null;
        const held = await this.load();
        if (held?.camera) {
            // A camera this browser already is. A link opened now starts nothing: a page is one camera, and this one carries on until it ends.
            this.hold(held);
            if (!(held.camera.endsAt > this.clock.now())) return { kind: 'over', why: 'time' };
            if ((await this.stillThere()) === 'gone') {
                // Gone near its end is its time, by the Worker's clock: otherwise someone in the home ended it.
                const why = goneBecause(held.camera.endsAt, this.clock.now());
                await this.forget();
                return { kind: 'over', why };
            }
            return { kind: 'kept', pass: this.passOf(), seen: { ...held.camera.seen } };
        }
        if (held?.asking) {
            this.hold(held);
            const asking = held.asking;
            if (link && link.inviteId !== asking.inviteId) {
                // Another code: the request it was waiting on goes, and it asks with this one, as the same device.
                if (asking.asked && held.session) await this.api.withdraw(asking.inviteId).catch(() => {});
                held.asking = await this.askingWith(link);
                await this.save();
            }
            return { kind: 'link' };
        }
        if (link) {
            this.link = link;
            return { kind: 'link' };
        }
        return { kind: 'nothing' };
    }

    /** @param {import('./kept.js').Held} held */
    hold(held) {
        this.held = held;
        if (held.session) this.api.use(held.deviceId, held.session);
    }

    /** Whether the home still has this camera: one ended while the page was shut is over. 'unknown' where the Worker can't say. */
    async stillThere() {
        try {
            const row = await this.api.me();
            return row.deviceId === this.held?.deviceId && row.householdId !== null ? 'yes' : 'gone';
        } catch (error) {
            return error instanceof NoSession ? 'gone' : 'unknown';
        }
    }

    // ---- Getting in --------------------------------------------------------

    /** @param {(code: string) => void} onCode @returns {Promise<import('./door.js').Pass>} */
    async join(onCode) {
        const giveUpAt = this.clock.now() + this.timing.askForAtMostMs;
        try {
            await this.registered(giveUpAt);
            return await this.asked(onCode, giveUpAt);
        } catch (error) {
            // A request that went nowhere leaves nothing behind: no device on the Worker, nothing in the browser.
            await this.leave();
            if (error instanceof Turned) throw error;
            throw new Turned('expired');
        }
    }

    /** A new key pair, and the id it makes. */
    async newKeys() {
        const deviceKey = await generateDeviceKey();
        return { deviceKey, deviceId: await cameraIdOf(deviceKey.publicKey) };
    }

    /** What it asks with, for a link: a new nonce and its commitment. @param {{ inviteId: string, invite: Awaited<ReturnType<typeof inviteKeys>> }} link */
    async askingWith(link) {
        const nonce = randomBytes(32);
        return { inviteId: link.inviteId, invite: link.invite, nonce, commitment: await nonceCommitment(nonce), asked: false, memberNonce: null };
    }

    /** A device on the Worker under its key's id, with a session: made, kept, then registered.
     * @param {number} giveUpAt */
    async registered(giveUpAt) {
        if (!this.held) {
            if (!this.link) throw new Turned('invalid');
            this.held = { ...(await this.newKeys()), session: null, asking: await this.askingWith(this.link), camera: null };
            this.link = null;
            await this.save();
        }
        const held = this.held;
        let newKeys = 0;
        let wait = this.timing.askEveryMs;
        while (!held.session) {
            try {
                const registered = await this.api.register({ publicKey: b64url(held.deviceKey.publicKey), model: this.options.model, appVersion: this.options.appVersion });
                // Its id is its key's. Under any other it takes nothing, the session included.
                if (registered.deviceId !== held.deviceId) throw new Turned('invalid');
                const { accessToken, refreshToken, expiresAt } = registered.session;
                held.session = { accessToken, refreshToken, expiresAt };
                this.api.use(held.deviceId, held.session);
                await this.save();
            } catch (error) {
                if (error instanceof WorkerSaid && error.code === 'key_in_use' && newKeys < NEW_KEYS_AT_MOST) {
                    // A key that already has a row: a new pair, and again.
                    newKeys += 1;
                    Object.assign(held, await this.newKeys());
                    await this.save();
                    continue;
                }
                if (error instanceof Unreachable && this.clock.now() + wait < giveUpAt) {
                    await this.sleep(wait);
                    wait = Math.min(wait * 2, this.timing.askAtMostEveryMs);
                    continue;
                }
                throw error instanceof Turned ? error : new Turned('expired');
            }
        }
    }

    /** Asks, shows the code once a member has answered, and takes the pass once approved.
     * @param {(code: string) => void} onCode @param {number} giveUpAt */
    async asked(onCode, giveUpAt) {
        const held = /** @type {import('./kept.js').Held} */ (this.held);
        const asking = /** @type {import('./kept.js').Asking} */ (held.asking);
        const publicKey = b64url(held.deviceKey.publicKey);
        /** The member nonce its own was revealed for, on this visit. */
        let revealedFor = null;
        let shown = null;
        let wait = this.timing.askEveryMs;
        let askedAgain = 0;
        for (;;) {
            if (this.clock.now() >= giveUpAt) throw new Turned('expired');
            try {
                if (!asking.asked) {
                    const proof = await asking.invite.proof(asking.inviteId, publicKey, asking.commitment);
                    await this.api.ask(asking.inviteId, { token_check: asking.invite.tokenHash, public_key: publicKey, proof, nonce_commitment: asking.commitment });
                    asking.asked = true;
                    asking.memberNonce = null;
                    revealedFor = null;
                    await this.save();
                }
                const request = await this.api.request(asking.inviteId);
                wait = this.timing.askEveryMs;
                if (request.status === 'approved') return await this.taken(asking, giveUpAt);
                if (request.status === 'denied') throw new Turned('denied');
                if (request.status === 'expired') throw new Turned('expired');
                if (request.memberNonce !== null) {
                    if (revealedFor !== request.memberNonce) {
                        await this.api.reveal(asking.inviteId, b64url(asking.nonce));
                        revealedFor = request.memberNonce;
                        if (asking.memberNonce !== request.memberNonce) {
                            asking.memberNonce = request.memberNonce;
                            await this.save();
                        }
                    }
                    const code = await asking.invite.code(asking.inviteId, publicKey, asking.nonce, request.memberNonce);
                    if (code !== shown) {
                        shown = code;
                        onCode(code);
                    }
                }
            } catch (error) {
                if (error instanceof Turned) throw error;
                if (error instanceof NoSession) throw new Turned('expired');
                if (error instanceof Unreachable) wait = Math.min(wait * 2, this.timing.askAtMostEveryMs);
                else if (error instanceof WorkerSaid && error.code === 'request_not_found' && askedAgain < 2) {
                    // Its request isn't there: asked again, with the same nonce and key.
                    askedAgain += 1;
                    asking.asked = false;
                    await this.save();
                    continue;
                } else if (error instanceof WorkerSaid && error.code === 'not_answered') {
                    // A moment behind: on with asking.
                } else if (error instanceof WorkerSaid && error.code === 'invalid_invite') throw new Turned('invalid');
                else throw new Turned('expired');
            }
            await this.sleep(wait);
        }
    }

    /** The pass, taken in its order, and the camera it makes kept.
     * @param {import('./kept.js').Asking} asking @param {number} giveUpAt @returns {Promise<import('./door.js').Pass>} */
    async taken(asking, giveUpAt) {
        const held = /** @type {import('./kept.js').Held} */ (this.held);
        const listed = await this.patiently(async () => {
            const found = await this.api.pass();
            // Approved and not yet there: a moment behind.
            if (found === null) throw new Unreachable('no pass yet');
            return found;
        }, giveUpAt, PASS_LOOKS);
        const row = await this.patiently(() => this.api.me(), giveUpAt, PASS_LOOKS);
        let taken;
        try {
            taken = await takePass({ deviceKey: held.deviceKey, givenId: row.deviceId, householdId: row.householdId, inviteId: asking.inviteId, invite: asking.invite, listed, now: this.clock.now() });
        } catch (error) {
            if (error?.name === 'SealError') throw new Turned(error.code === 'over' ? 'expired' : 'invalid');
            throw error;
        }
        held.camera = { inviteId: asking.inviteId, keys: taken.keys, startedAt: taken.startedAt, endsAt: taken.endsAt, latestEndAt: taken.latestEndAt, startedBy: taken.startedBy, seen: {} };
        held.asking = null;
        await this.save();
        return this.passOf();
    }

    /** What `ask` gives, asked again while the Worker can't be reached, a few times at most.
     * @template T @param {() => Promise<T>} ask @param {number} giveUpAt @param {number} times @returns {Promise<T>} */
    async patiently(ask, giveUpAt, times) {
        for (let tries = 1; ; tries += 1) {
            try {
                return await ask();
            } catch (error) {
                if (!(error instanceof Unreachable) || tries >= times || this.clock.now() + this.timing.askEveryMs >= giveUpAt) throw error;
                await this.sleep(this.timing.askEveryMs);
            }
        }
    }

    /** The camera it is, as the page holds it. @returns {import('./door.js').Pass} */
    passOf() {
        const held = /** @type {import('./kept.js').Held} */ (this.held);
        const camera = /** @type {import('./kept.js').Became} */ (held.camera);
        return { cameraId: held.deviceId, keys: camera.keys, endsAt: camera.endsAt, latestEndAt: camera.latestEndAt, startedBy: camera.startedBy };
    }

    // ---- A camera ----------------------------------------------------------

    /** Its socket, started: each time it opens, a new one-use ticket. A device the home no longer has is over. */
    connect() {
        const link = new SocketLink({
            open: async () => {
                if (this.leaving || !this.held?.camera) throw new Gone();
                let ticket;
                try {
                    ticket = await this.api.ticket();
                } catch (error) {
                    if (error instanceof NoSession) throw new Gone();
                    if (error instanceof WorkerSaid && error.status === 403 && error.code === 'no_household') throw new Gone();
                    throw error;
                }
                return new this.options.WebSocket(this.api.socketAddress(ticket.ticket, this.options.appVersion));
            },
            clock: this.clock,
        });
        link.start();
        return link;
    }

    /** Relay addresses, kept until less than an hour is left of them. @param {boolean} fresh asked anew whatever is kept */
    async iceAnswer(fresh) {
        if (!fresh && this.ice && this.ice.expiresAt - this.clock.now() > ICE_ASK_AGAIN_MS) return this.ice;
        const answer = await this.api.iceServers();
        this.ice = answer;
        if (answer.relay !== null) this.relay = answer.relay;
        return answer;
    }

    /** Every server the Worker lists: a session made without the relay leaves the TURN ones out itself (src/rtc/relay.js). */
    async iceServers() {
        const answer = await this.iceAnswer(false);
        return answer.iceServers.map((server) => ({
            urls: [...server.urls],
            ...(server.username !== null ? { username: server.username } : {}),
            ...(server.credential !== null ? { credential: server.credential } : {}),
        }));
    }

    /** What its home's plan allows it and the Worker's clock (`GET /v1/me`), and whether the month has relay hours left (`GET /v1/ice-servers`). @returns {Promise<import('./door.js').Allowance>} */
    async allowance() {
        const row = await this.api.me();
        if (row.deviceId !== this.held?.deviceId) throw new Error("the Worker answered with another device's row");
        try {
            await this.iceAnswer(true);
        } catch {
            // Without a plan the route answers 402, and no watch reaches the camera anyway: what it last heard stands.
        }
        return { limits: row.limits, relay: this.relay, serverNow: row.now };
    }

    /** @param {import('./door.js').Pass} _pass @param {number} seconds */
    async relayed(_pass, seconds) {
        try {
            const left = await this.api.relayed(seconds);
            if (left === null) return null;
            this.relay = left;
            return { relay: left };
        } catch (error) {
            // Refused for good: those seconds go. Not made at all: they go with the next report.
            if (error instanceof WorkerSaid) return null;
            throw error;
        }
    }

    /** A later end, never past the latest its pass named, and the command ids it carried out.
     * @param {import('./door.js').Pass} pass @param {Record<string, number>} seen */
    async keep(pass, seen) {
        const camera = this.held?.camera;
        if (!camera || this.leaving) return;
        if (Number.isSafeInteger(pass.endsAt)) camera.endsAt = Math.min(Math.max(camera.endsAt, pass.endsAt), camera.latestEndAt);
        camera.seen = { ...seen };
        await this.save();
    }

    /** Its end: the device deleted on the Worker, and everything the browser kept, whether or not the Worker can be reached, never waiting long on it. */
    leave() {
        this.left ??= (async () => {
            this.leaving = true;
            const deleted = this.held?.session ? this.api.deleteMe().catch(() => {}) : Promise.resolve();
            await this.forget();
            await Promise.race([deleted, this.sleep(this.timing.leaveWaitsMs)]);
        })();
        return this.left;
    }

    // ---- What it keeps -----------------------------------------------------

    /** What the browser kept, checked; a record that isn't one goes. */
    async load() {
        let value;
        try {
            value = await this.options.store.get(KEPT_KEY);
        } catch {
            return null;
        }
        if (value === undefined) return null;
        const held = await readKept(value);
        if (!held) await this.options.store.clear().catch(() => {});
        return held;
    }

    async save() {
        if (this.leaving || !this.held) return;
        try {
            await this.options.store.set(KEPT_KEY, toKeep(this.held));
        } catch {
            // A browser that keeps nothing: the camera runs, and won't outlast a reload.
        }
    }

    async forget() {
        this.held = null;
        await this.options.store.clear().catch(() => {});
    }

    /** A refresh brought a new session: it's kept. @param {import('./kept.js').KeptSession} session */
    sessionChanged(session) {
        if (!this.held || this.leaving) return;
        this.held.session = session;
        this.save();
    }

    /** @param {number} ms */
    sleep(ms) {
        return new Promise((resolve) => this.clock.setTimeout(() => resolve(undefined), ms));
    }
}
