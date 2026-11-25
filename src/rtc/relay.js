// A session made without the relay (docs/API.md, Realtime, The Relay
// switch; Temporary cameras, The Relay switch): what the apps' cameras do
// for one, here for a page (PetCam/Realtime/RelaySwitch.swift, RelayGuard).
//
// A page has no switch of its own. A viewer whose switch is off says
// `"relay": false` in its `watch`, and that alone decides. Such a session:
//
// 1. has no relay of its own: its connection is made with every TURN
//    server left out (`withoutRelay`), so it gathers no relay candidates;
// 2. takes none of the viewer's: that end's relay candidates never reach
//    the connection, trickled (`keepsCandidate`) or written into its answer
//    (`withoutRelayCandidates`);
// 3. says so in its offer (`"relay": false`, never true);
// 4. and ends if the path it ends up on runs through a relay all the same
//    (`pathRelays`): a relay kept out by 2 can still reach this end first,
//    and the browser then takes it as a candidate of its own finding
//    (peer-reflexive), keeping its address to itself and saying its port.

import { STUN_ONLY } from '../wire/frames.js';

/** A TURN server's address (`turn:` or `turns:`); a STUN one isn't. @param {unknown} url */
export function isRelayUrl(url) {
    if (typeof url !== 'string') return false;
    const scheme = url.split(':')[0].toLowerCase();
    return scheme === 'turn' || scheme === 'turns';
}

/** The servers with every TURN address taken out, and no credentials, which
 * only a relay asks for. A list left empty gets the STUN server a call falls
 * back on, so a direct path across the internet can still be found.
 * @param {RTCIceServer[]} servers @returns {RTCIceServer[]} */
export function withoutRelay(servers) {
    const kept = [];
    for (const server of servers) {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => typeof url === 'string' && !isRelayUrl(url));
        if (urls.length > 0) kept.push({ urls });
    }
    return kept.length > 0 ? kept : STUN_ONLY.map((server) => ({ urls: [...server.urls] }));
}

/**
 * What an ICE candidate's line says of itself: `candidate:<foundation>
 * <component> <transport> <priority> <address> <port> typ <type> …` (RFC
 * 8839), as a signal carries it or as a line of a description (`a=…`). Null
 * for a line that isn't one.
 * @param {unknown} line @returns {{ type: string, port: number } | null} `type` is host, srflx, prflx or relay
 */
export function readCandidate(line) {
    if (typeof line !== 'string') return null;
    let text = line.trim();
    if (text.startsWith('a=')) text = text.slice(2);
    if (!text.startsWith('candidate:')) return null;
    const fields = text.slice('candidate:'.length).split(' ').filter(Boolean);
    if (fields.length < 8 || fields[6] !== 'typ' || !/^\d{1,5}$/.test(fields[5])) return null;
    const port = Number(fields[5]);
    if (port > 65_535) return null;
    return { type: fields[7].toLowerCase(), port };
}

/** Whether a session made without the relay hands this candidate of the
 * viewer's to its connection: any but a relay one. One it can't read is
 * left out too: nothing sends one, and it might be anything.
 * @param {unknown} candidate */
export function keepsCandidate(candidate) {
    const read = readCandidate(candidate);
    return read !== null && read.type !== 'relay';
}

/** An answer without its relay candidates, and the ports of the ones taken
 * out. The apps' own carry none (candidates trickle), so this is for what
 * another end might write. Line by line with each line's own ending kept,
 * so nothing else changes.
 * @param {string} sdp @returns {{ sdp: string, ports: Set<number> }} */
export function withoutRelayCandidates(sdp) {
    const ports = new Set();
    const kept = [];
    for (const line of sdp.split('\n')) {
        const text = line.endsWith('\r') ? line.slice(0, -1) : line;
        const candidate = text.startsWith('a=candidate:') ? readCandidate(text) : null;
        if (candidate?.type === 'relay') ports.add(candidate.port);
        else kept.push(line);
    }
    return { sdp: ports.size === 0 ? sdp : kept.join('\n'), ports };
}

/**
 * Whether the path a session made without the relay ended up on runs
 * through one: either end's candidate a relay one, or the viewer's a
 * peer-reflexive one on the port of a relay candidate this end left out.
 * Where the browser says not even the port, a peer-reflexive path counts as
 * relayed whenever a relay candidate was left out, rather than chance it.
 * @param {{ localType: string | null, remoteType: string | null, remotePort: number | null }} path
 * @param {{ size: number, has(port: number): boolean }} leftOut the ports of the viewer's relay candidates left out
 */
export function pathRelays(path, leftOut) {
    if (path.localType === 'relay' || path.remoteType === 'relay') return true;
    if (path.remoteType !== 'prflx' || leftOut.size === 0) return false;
    if (path.remotePort === null || !(path.remotePort > 0)) return true;
    return leftOut.has(path.remotePort);
}

/** How long a viewer whose session was ended for a relayed path is held off. */
export const RELAY_OFF_HOLD_MS = 30_000;

/**
 * The viewers a camera just ended a session with because the session was
 * made without the relay and its path ran through one all the same
 * (`relay_off`). A viewer that knows the reason doesn't ask again by
 * itself. Should one ask again the same way all the same, for half a minute
 * it is answered the same way, with nothing set up to relay.
 */
export class RelayOffHolds {
    constructor() {
        /** @type {Map<string, number>} viewer → until when, ms */
        this.until = new Map();
    }

    /** @param {string} viewer @param {number} now ms */
    ended(viewer, now) {
        this.until.set(viewer, now + RELAY_OFF_HOLD_MS);
    }

    /** @param {string} viewer @param {number} now ms */
    holds(viewer, now) {
        for (const [who, until] of this.until) if (until <= now) this.until.delete(who);
        return this.until.has(viewer);
    }
}
