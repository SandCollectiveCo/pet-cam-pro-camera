// THE SEAM between the page and getting into a home. Everything else in the
// page is written against the one interface below, a `Door`, so the same
// page runs on the real one and on a test's.
//
//   src/join/worker-door.js   a release's: through the Worker (docs/API.md,
//                             Temporary cameras), its link, its key's own
//                             id, the request, the pass taken in its order,
//                             the socket's one-use ticket, what it keeps
//   dev/door.js               a test's: a made-up pass and a stand-in socket,
//                             for everything after getting in
//   dev/worker.js             a stand-in Worker, in memory, that the real door
//                             runs against in a test, and that plays a home's
//                             member from the other side
//
// What a camera does once it's in is not the door's: its commands (`peek`,
// `keep`, `end`), its status with the end it holds itself to, who's calling
// in a `watch`, a watch that asks to go without the relay, and a plan that
// runs out (src/camera/, src/rtc/, src/wire/).

/**
 * What a temporary camera is handed when a member approves it: a key of its
 * own, never a key of the home's (docs/WEB-CAMERA.md § 3).
 * @typedef {object} Pass
 * @property {string} cameraId this device's id on the Worker
 * @property {import('../crypto/keys.js').KeySet} keys its own keys, under the home's epoch when it started
 * @property {number} endsAt when it ends, ms
 * @property {number} latestEndAt the latest it may ever be extended to, ms
 * @property {string | null} startedBy the name of the person who started it, for its screen; null where they gave none
 */

/**
 * What this visit to the page is.
 * @typedef {{ kind: 'nothing' }
 *   | { kind: 'link' }
 *   | { kind: 'kept', pass: Pass, seen: Record<string, number> }
 *   | { kind: 'over', why: 'time' | 'gone' }} Arrival
 * `nothing`: opened with no link and nothing kept. `link`: opened from a
 * viewer's code or link, which the door has read (the page's entry took it
 * out of the address first thing), or a request it was waiting on before a
 * reload. `kept`: a camera this browser was already, still within its time,
 * with the command ids it carried out. `over`: a camera this browser was,
 * whose time has passed (`time`, and the door is to `leave`), or which the
 * home ended while the page was shut (`gone`, already forgotten).
 */

/**
 * What the Worker says of this camera: what its home's plan allows it, and
 * the Worker's clock (docs/API.md, Temporary cameras, Its own routes).
 * @typedef {object} Allowance
 * @property {import('../wire/frames.js').Limits | null} limits the tallest picture on any connection and through the relay (`GET /v1/me`, `limits`); null while its home has no plan that allows a temporary camera: nobody can watch then, and nothing ends
 * @property {boolean} relay whether the home has relay hours left this month (`GET /v1/ice-servers`, `relay`)
 * @property {number | null} serverNow the Worker's clock as it answered, ms (`GET /v1/me`, `now`): to say so when this device's is more than 90 seconds from it, never to set anything by; null where the Worker didn't say
 */

/**
 * @typedef {object} Door
 * @property {() => Promise<Arrival>} arrive
 * @property {(onCode: (code: string) => void) => Promise<Pass>} join asks to join with the link, shows the six digits through `onCode` once there are any, and gives the pass when a member approves; throws `Turned` when it's turned down, the link is no good, or what was handed over isn't a pass, having left nothing behind
 * @property {(pass: Pass) => import('../camera/link.js').Link} connect the socket to the home, started. Besides signals and commands it hands on the Worker's `limits_changed` and the `error` for a signal of the camera's own, as they come
 * @property {(pass: Pass) => Promise<RTCIceServer[]>} iceServers relay addresses under the home's plan: every server the Worker lists. A session made without the relay leaves the TURN ones out itself (src/rtc/relay.js), so the door asks the same either way
 * @property {(pass: Pass) => Promise<Allowance>} allowance asked as the camera starts and each time its socket opens
 * @property {(pass: Pass, seconds: number) => Promise<{ relay: boolean } | null>} relayed reports the live video the camera relayed since its last report (`POST /v1/household/relay`, 1 to 600 seconds): gives whether the home has relay hours left, null where the Worker refused the report for good, and throws where it couldn't be made, to be made again
 * @property {(pass: Pass, seen: Record<string, number>) => Promise<void>} keep what has to outlast a reload: the command ids carried out, and a later end
 * @property {() => Promise<void>} leave the end: deletes this device on the Worker and everything the browser kept. What the browser kept goes whether or not the Worker can be reached, and it never waits long on the Worker: the page says it's over only once this is done
 */

/** Why joining didn't happen: a member said no, the link was used or too old, or it was never one of ours. */
export class Turned extends Error {
    /** @param {'denied' | 'expired' | 'invalid'} why */
    constructor(why) {
        super(`not let in: ${why}`);
        this.name = 'Turned';
        this.why = why;
    }
}

/**
 * How near its end a camera has to be for an end the Worker brings (its
 * row gone, its socket closed with 4003) to be its time rather than a
 * viewer's doing. The Worker ends a temporary camera at its own copy of
 * the end, by its own clock, which a page's may be this far from and still
 * be watched (src/camera/camera.js, `CLOCK_OFF_MS`): so the Worker's end
 * often comes a moment before the page's own look at its clock does.
 */
export const ITS_TIME_WITHIN_MS = 90_000;

/** Why a camera the Worker no longer has is over: its time, where that has
 * nearly come by this page's clock, and otherwise a viewer's doing.
 * @param {number} endsAt @param {number} now @returns {'time' | 'gone'} */
export const goneBecause = (endsAt, now) => (now >= endsAt - ITS_TIME_WITHIN_MS ? 'time' : 'gone');

/** The six digits both devices show, as the page shows them: "123 456". @param {unknown} code */
export const isCode = (code) => typeof code === 'string' && /^\d{3} \d{3}$/.test(code);
