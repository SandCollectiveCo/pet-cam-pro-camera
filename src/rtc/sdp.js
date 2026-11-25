// What a camera reads from, and takes out of, a session description. An
// offer is text the browser writes; the few things the page needs of it are
// done here, line by line, and nothing else is touched.

/** @param {string} sdp @returns {string[]} */
const linesOf = (sdp) => sdp.split(/\r\n|\n/);

/** The DTLS fingerprints a description names, each as "sha-256 AB:CD:…"
 * (the algorithm in lower case, the bytes in upper): the certificate a
 * connection ends up with has to be one of them.
 * @param {string} sdp @returns {Set<string>} */
export function fingerprintsIn(sdp) {
    const found = new Set();
    for (const line of linesOf(sdp)) {
        const match = /^a=fingerprint:(\S+)\s+(\S+)/.exec(line);
        if (match) found.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
    }
    return found;
}

/** The address of the header extension an `a=extmap` line maps, or null for
 * any other line. `a=extmap-allow-mixed` is no extension.
 * @param {string} line */
function extensionOf(line) {
    const match = /^a=extmap:\d+(?:\/\S+)?\s+(\S+)/.exec(line);
    return match ? match[1] : null;
}

/** Every header extension a description names, once each.
 * @param {string} sdp @returns {string[]} */
export function extensionsIn(sdp) {
    const found = new Set();
    for (const line of linesOf(sdp)) {
        const uri = extensionOf(line);
        if (uri) found.add(uri);
    }
    return [...found];
}

/** The description with every header extension but `allowed` taken out: for
 * a browser that has no call to stop one (Safari), and as a second look for
 * one that has.
 * @param {string} sdp @param {readonly string[]} allowed @returns {string} */
export function withOnlyExtensions(sdp, allowed) {
    const ending = sdp.includes('\r\n') ? '\r\n' : '\n';
    return linesOf(sdp).filter((line) => {
        const uri = extensionOf(line);
        return uri === null || allowed.includes(uri);
    }).join(ending);
}

/** The codecs of each media section, in the order it lists them: what a
 * camera offered, or what a viewer answered.
 * @param {string} sdp @returns {{ kind: string, codecs: string[] }[]} */
export function codecsIn(sdp) {
    const sections = [];
    let current = null;
    for (const line of linesOf(sdp)) {
        const media = /^m=(\S+)\s+\S+\s+\S+\s*(.*)$/.exec(line);
        if (media) {
            current = { kind: media[1], order: media[2].split(/\s+/).filter(Boolean), names: new Map() };
            sections.push(current);
            continue;
        }
        const map = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
        if (map && current) current.names.set(map[1], map[2]);
    }
    return sections.map((section) => ({ kind: section.kind, codecs: section.order.map((payload) => section.names.get(payload)).filter(Boolean) }));
}

/** How each media section is to flow, as the description says:
 * "sendrecv", "recvonly"… @param {string} sdp @returns {{ kind: string, direction: string | null }[]} */
export function directionsIn(sdp) {
    const sections = [];
    for (const line of linesOf(sdp)) {
        const media = /^m=(\S+)/.exec(line);
        if (media) sections.push({ kind: media[1], direction: null });
        else if (sections.length > 0 && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) sections[sections.length - 1].direction = line.slice(2);
    }
    return sections;
}
