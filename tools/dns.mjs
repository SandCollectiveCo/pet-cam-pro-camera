// A DNS query, and the answer to it, as RFC 1035 writes them: what DNS over
// HTTPS carries (RFC 8484, `application/dns-message`), so every public
// resolver that offers it is asked the same way. For the watch on the page's
// name (tools/watch.mjs): one name, one type, and the answer's records.

/** The record types the watch asks for. */
export const TYPE = Object.freeze({ A: 1, CNAME: 5, AAAA: 28 });
/** No such name. */
export const NXDOMAIN = 3;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\*$/i;

/**
 * A query for one name and type: id 0 (as RFC 8484 asks, so answers can be
 * cached), recursion wanted, and the AD bit, which asks the resolver to say
 * whether DNSSEC checked its answer.
 * @param {string} name @param {number} type @returns {Uint8Array}
 */
export function dnsQuery(name, type) {
    const labels = name.replace(/\.$/, '').split('.');
    if (labels.some((label) => !LABEL.test(label)) || name.length > 253) throw new Error(`not a name a query can carry: ${name}`);
    const bytes = [0, 0, 0x01, 0x20, 0, 1, 0, 0, 0, 0, 0, 0];
    for (const label of labels) bytes.push(label.length, ...new TextEncoder().encode(label.toLowerCase()));
    bytes.push(0, type >> 8, type & 0xff, 0, 1);
    return Uint8Array.from(bytes);
}

/** A name in a message, which may point back to an earlier one. @param {Uint8Array} bytes @param {number} at */
function readName(bytes, at) {
    const labels = [];
    let next = null;
    let jumps = 0;
    let length = 0;
    for (;;) {
        if (at >= bytes.length) throw new Error('a name runs past the message');
        const size = bytes[at];
        if ((size & 0xc0) === 0xc0) {
            if (at + 1 >= bytes.length || ++jumps > 64) throw new Error('a name points nowhere, or round in circles');
            next ??= at + 2;
            at = ((size & 0x3f) << 8) | bytes[at + 1];
            continue;
        }
        if ((size & 0xc0) !== 0) throw new Error('a label of a kind this doesn’t read');
        if (size === 0) return { name: labels.join('.').toLowerCase(), next: next ?? at + 1 };
        if (at + 1 + size > bytes.length) throw new Error('a label runs past the message');
        labels.push(new TextDecoder().decode(bytes.subarray(at + 1, at + 1 + size)));
        length += size + 1;
        if (length > 255) throw new Error('a name longer than DNS allows');
        at += 1 + size;
    }
}

/**
 * An answer, read: its response code, whether the resolver says DNSSEC
 * checked it (AD), whether it was cut short (TC), and each record of its
 * answer section, with an address as its bytes and a name as text. Throws
 * for anything that isn't a DNS answer.
 * @param {Uint8Array} bytes
 * @returns {{ rcode: number, authenticated: boolean, truncated: boolean, answers: { name: string, type: number, ttl: number, address?: Uint8Array, target?: string }[] }}
 */
export function dnsAnswer(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12) throw new Error('shorter than a DNS header');
    const word = (at) => {
        if (at + 2 > bytes.length) throw new Error('the message ends early');
        return (bytes[at] << 8) | bytes[at + 1];
    };
    const flags = word(2);
    if ((flags & 0x8000) === 0) throw new Error('a query, not an answer');
    const questions = word(4);
    const count = word(6);
    let at = 12;
    for (let i = 0; i < questions; i++) at = readName(bytes, at).next + 4;
    const answers = [];
    for (let i = 0; i < count; i++) {
        const owner = readName(bytes, at);
        at = owner.next;
        const type = word(at);
        const ttl = word(at + 4) * 65_536 + word(at + 6);
        const size = word(at + 8);
        const data = at + 10;
        if (data + size > bytes.length) throw new Error('a record runs past the message');
        /** @type {{ name: string, type: number, ttl: number, address?: Uint8Array, target?: string }} */
        const record = { name: owner.name, type, ttl };
        if (type === TYPE.A && size === 4) record.address = bytes.slice(data, data + 4);
        else if (type === TYPE.AAAA && size === 16) record.address = bytes.slice(data, data + 16);
        else if (type === TYPE.CNAME) record.target = readName(bytes, data).name;
        answers.push(record);
        at = data + size;
    }
    return { rcode: flags & 0x000f, authenticated: (flags & 0x0020) !== 0, truncated: (flags & 0x0200) !== 0, answers };
}

/** An address as bytes, the way two answers are compared: an IPv4-mapped IPv6 address is its IPv4. @param {Uint8Array} address */
export function plainAddress(address) {
    if (address.length === 16 && address.subarray(0, 10).every((b) => b === 0) && address[10] === 0xff && address[11] === 0xff) return address.slice(12);
    return address;
}

/** An address as people write it. @param {Uint8Array} address */
export function addressText(address) {
    if (address.length === 4) return [...address].join('.');
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((address[i] << 8) | address[i + 1]).toString(16));
    // The longest run of two or more zero groups, written as "::" (RFC 5952).
    let best = -1;
    let length = 1;
    for (let i = 0; i < 8; ) {
        let j = i;
        while (j < 8 && groups[j] === '0') j += 1;
        if (j - i > length) {
            best = i;
            length = j - i;
        }
        i = j > i ? j : i + 1;
    }
    return best < 0 ? groups.join(':') : `${groups.slice(0, best).join(':')}::${groups.slice(best + length).join(':')}`;
}
