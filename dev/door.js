// A stand-in for the door (src/join/door.js), for everything after getting
// in: it hands the page a made-up pass and a stand-in for the Worker's
// socket, so the camera runs in a test or by hand with no home, no Worker
// and no key that was ever anyone's.
//
// What it makes up is only what the real door brings: a camera's own
// secret, an end, the name of whoever started it, what its home's plan
// allows it and the Worker's clock. How a real camera gets those (the
// invite, the pass, the routes) is src/join/worker-door.js, which runs in
// a test against a stand-in Worker (dev/worker.js).

import { KeySet } from '../src/crypto/keys.js';
import { randomBytes, randomId } from '../src/crypto/primitives.js';
import { Turned } from '../src/join/door.js';

/**
 * @param {{
 *   relay: import('./relay.js').Relay,
 *   arrive?: 'link' | 'kept' | 'nothing' | 'over',
 *   startedBy?: string | null,
 *   lastsMs?: number,
 *   latestMs?: number,
 *   code?: string,
 *   approves?: 'by itself' | 'when told' | 'never',
 *   clockOffMs?: number | null,
 *   limits?: { liveHeight: number, relayHeight: number } | null,
 *   iceServers?: RTCIceServer[],
 *   relayReports?: ('taken' | 'used up' | 'refused' | 'unreachable')[],
 *   now?: () => number,
 * }} how `limits` null: the home has no plan that allows the camera; `clockOffMs` null: the Worker doesn't say its time
 */
export async function standInDoor(how) {
    const now = how.now ?? (() => Date.now());
    const cameraId = randomId();
    const secret = randomBytes(32);
    const epoch = 7;
    const pass = {
        cameraId,
        keys: await KeySet.forCamera(Uint8Array.from(secret), epoch),
        endsAt: now() + (how.lastsMs ?? 86_400_000),
        latestEndAt: now() + (how.latestMs ?? 7 * 86_400_000),
        startedBy: how.startedBy === undefined ? 'Maya Lopez' : how.startedBy,
    };
    let approve = () => {};
    let refuse = () => {};
    const door = {
        cameraId,
        pass,
        /** The camera's keys as a member of the home will hold them, from its entry: for a stand-in viewer. A member can open its stills, which the camera itself can't. */
        memberKeys: () => KeySet.fromSecrets({ [epoch]: Uint8Array.from(secret) }),
        /** What the page asked the door to keep, and whether it has left. */
        kept: [],
        /** The relayed seconds it reported, and how each report in turn is to go (the last stands for the rest). */
        reported: [],
        relayReports: [...(how.relayReports ?? ['taken'])],
        /** What the Worker would say the home's plan allows the camera, to change as a test goes; and how often it was asked. */
        limits: how.limits === undefined ? { liveHeight: 1080, relayHeight: 720 } : how.limits,
        asked: 0,
        /** The relay addresses it hands out, and how often it was asked for them. */
        servers: how.iceServers ?? [],
        askedForServers: 0,
        left: false,
        link: null,
        approve: () => approve(),
        refuse: (why = 'denied') => refuse(new Turned(why)),
        /** A frame from the Worker itself to the camera's socket: `limits_changed`, or an `error` for a signal of its own. */
        say: (frame) => door.link?.onText?.(JSON.stringify(frame)),

        arrive: async () => {
            const kind = how.arrive ?? 'link';
            if (kind === 'kept') return { kind, pass, seen: {} };
            if (kind === 'over') return { kind, why: 'time' };
            return { kind };
        },
        join: (onCode) => new Promise((resolve, reject) => {
            approve = () => resolve(pass);
            refuse = reject;
            setTimeout(() => onCode(how.code ?? '862 673'), 150);
            if ((how.approves ?? 'by itself') === 'by itself') setTimeout(() => resolve(pass), 900);
        }),
        connect: () => {
            door.link = how.relay.join(cameraId);
            // As a socket would be: open a moment later, and closed when the camera stops.
            door.link.stop = () => {
                door.link.isOpen = false;
                how.relay.leave(cameraId);
            };
            return door.link;
        },
        iceServers: async () => {
            door.askedForServers += 1;
            return door.servers.map((server) => ({ ...server }));
        },
        allowance: async () => {
            door.asked += 1;
            return { limits: door.limits, relay: true, serverNow: how.clockOffMs === null ? null : now() + (how.clockOffMs ?? 0) };
        },
        relayed: async (_pass, seconds) => {
            door.reported.push(seconds);
            const goes = door.relayReports.length > 1 ? door.relayReports.shift() : door.relayReports[0];
            if (goes === 'unreachable') throw new Error('the Worker could not be reached');
            return goes === 'refused' ? null : { relay: goes !== 'used up' };
        },
        keep: async (_pass, seen) => {
            door.kept.push({ endsAt: pass.endsAt, seen });
        },
        leave: async () => {
            door.left = true;
        },
    };
    return door;
}
