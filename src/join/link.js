// A camera invite's link, as the page reads it (docs/API.md, Temporary
// cameras, The camera invite; vectors/temporary-camera-v1.json,
// `invite.link`): the page's address exactly as the build carries it, "#",
// then base64url of the JSON {"v": 3, "i": "<invite id>", "t": "<token>"}.
// Nothing of the home's is in it: no id, no name.
//
// The address is compared whole, with a path or with none: nothing reads
// it as an origin and a path. The payload rides in the fragment only, which
// a browser never sends to the host.
//
// This reads, and nothing else. Taking the fragment out of the address at
// once, and asking with the invite, are the door's (src/join/door.js).

import { fromB64url, textOf } from '../crypto/bytes.js';

const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The invite in a link, or null for anything that isn't one of this page's:
 * another address, another version, a token that isn't 32 bytes, an id that
 * isn't a UUID. The id reads lowercase.
 * @param {unknown} link the page's whole address as it was opened
 * @param {string | null} page the page's own address, as the build carries it (src/config.js, `PAGE`)
 * @returns {{ inviteId: string, token: Uint8Array } | null}
 */
export function readCameraInviteLink(link, page) {
    if (typeof link !== 'string' || typeof page !== 'string' || !link.startsWith(`${page}#`)) return null;
    let payload;
    try {
        payload = JSON.parse(textOf(fromB64url(link.slice(page.length + 1))));
    } catch {
        return null;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 3 || typeof payload.i !== 'string' || typeof payload.t !== 'string') return null;
    let token;
    try {
        token = fromB64url(payload.t);
    } catch {
        return null;
    }
    if (token.length !== 32 || !UUID_ANY_CASE.test(payload.i)) return null;
    return { inviteId: payload.i.toLowerCase(), token };
}
