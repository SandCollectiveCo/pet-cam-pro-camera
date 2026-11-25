// A UDP forwarder between two ends of a call on this computer that reads,
// and never changes, what passes: which SRTP suites each DTLS hello names,
// which DTLS version was agreed, and which RTP header extensions are on the
// wire. Each end is given the other side's socket here as its only remote
// candidate. It needs no root and no packet capture.
//
// It can also stand in for a relay one end holds and the other never asked
// for (`reach`): told which ports the first end listens on, on this
// computer, it passes the second end's packets on to them before the first
// end has sent it anything, which is how a relay kept out of a call can
// still reach a camera first.
//
// A connection's own report says which suite a call agreed; only the wire
// says what was offered, and what a header carries in the clear: marker
// 0xBEDE is one-byte extensions as SRTP leaves them, readable; 0xC0DE would
// be RFC 9335's encrypted ones.

import dgram from 'node:dgram';
import os from 'node:os';

/** This computer's own address on its network: two ends in one browser reach each other through it. */
export const lanAddress = (() => {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const address of list ?? []) if (address.family === 'IPv4' && !address.internal) return address.address;
    }
    return '127.0.0.1';
})();

const SRTP = { 1: 'AES_CM_128_HMAC_SHA1_80', 2: 'AES_CM_128_HMAC_SHA1_32', 7: 'AEAD_AES_128_GCM', 8: 'AEAD_AES_256_GCM' };

/** @param {Buffer} buffer @param {number} at @param {number} end @param {Record<string, unknown>} out @param {'client_hello' | 'server_hello'} who */
function readExtensions(buffer, at, end, out, who) {
    while (at + 4 <= end) {
        const type = buffer.readUInt16BE(at);
        const length = buffer.readUInt16BE(at + 2);
        const data = buffer.subarray(at + 4, at + 4 + length);
        if (type === 14 && data.length >= 2) {
            // use_srtp: the SRTP suites this end will do.
            const bytes = data.readUInt16BE(0);
            const suites = [];
            for (let i = 2; i + 1 < 2 + bytes; i += 2) suites.push(SRTP[data.readUInt16BE(i)] ?? `0x${data.readUInt16BE(i).toString(16)}`);
            out[`${who}_srtp`] = suites;
        }
        if (type === 43) {
            // supported_versions: 0xfefc is DTLS 1.3, 0xfefd DTLS 1.2.
            const versions = [];
            if (who === 'client_hello') for (let i = 1; i + 1 < data.length; i += 2) versions.push(`0x${data.readUInt16BE(i).toString(16)}`);
            else versions.push(`0x${data.readUInt16BE(0).toString(16)}`);
            out[`${who}_versions`] = versions;
        }
        at += 4 + length;
    }
}

/** @param {Buffer} body a whole ClientHello (1) or ServerHello (2) @param {number} type @param {Record<string, unknown>} out */
function readHello(body, type, out) {
    try {
        let at = 2 + 32; // version, random
        at += 1 + body[at]; // session id
        if (type === 1) {
            at += 1 + body[at]; // cookie
            at += 2 + body.readUInt16BE(at); // cipher suites
            at += 1 + body[at]; // compression
            if (at + 2 <= body.length) readExtensions(body, at + 2, at + 2 + body.readUInt16BE(at), out, 'client_hello');
        } else {
            at += 3; // cipher suite, compression
            if (at + 2 <= body.length) readExtensions(body, at + 2, at + 2 + body.readUInt16BE(at), out, 'server_hello');
        }
    } catch {
        out.unread = (out.unread ?? 0) + 1;
    }
}

/** @param {any} proxy @param {'a_to_b' | 'b_to_a'} direction @param {Buffer} packet */
function read(proxy, direction, packet) {
    const seen = proxy.seen;
    const first = packet[0];
    if (first <= 3) {
        seen.stun += 1;
        return;
    }
    if (first >= 20 && first <= 63) {
        seen.dtls += 1;
        // Handshake records in the clear (epoch 0), which may come in pieces.
        let at = 0;
        while (at + 13 <= packet.length && packet[at] === 22) {
            const epoch = packet.readUInt16BE(at + 3);
            const length = packet.readUInt16BE(at + 11);
            const record = packet.subarray(at + 13, at + 13 + length);
            at += 13 + length;
            if (epoch !== 0 || record.length < 12) continue;
            const type = record[0];
            if (type !== 1 && type !== 2) continue;
            const total = record.readUIntBE(1, 3);
            const sequence = record.readUInt16BE(4);
            const offset = record.readUIntBE(6, 3);
            const fragment = record.readUIntBE(9, 3);
            const key = `${direction}:${type}:${sequence}`;
            const slot = (proxy.pieces[key] ??= { total, got: 0, body: Buffer.alloc(total), offsets: new Set(), done: false });
            if (!slot.offsets.has(offset)) {
                record.copy(slot.body, offset, 12, 12 + fragment);
                slot.offsets.add(offset);
                slot.got += fragment;
            }
            if (slot.got >= slot.total && !slot.done) {
                slot.done = true;
                seen[type === 1 ? 'client_hello_from' : 'server_hello_from'] = direction;
                readHello(slot.body, type, seen);
            }
        }
        return;
    }
    if (first >= 128 && first <= 191) {
        if (packet[1] >= 192 && packet[1] <= 223) {
            seen.rtcp += 1;
            return;
        }
        seen.rtp += 1;
        const sent = (seen.rtp_from[direction] ??= { packets: 0, with_extensions: 0, markers: {}, ids: {} });
        sent.packets += 1;
        if ((first & 0x10) === 0) return;
        sent.with_extensions += 1;
        const at = 12 + 4 * (first & 0x0f);
        if (at + 4 > packet.length) return;
        const marker = packet.readUInt16BE(at).toString(16);
        sent.markers[marker] = (sent.markers[marker] ?? 0) + 1;
        if (marker !== 'bede') return;
        // One-byte header extensions: an id and a length, then the data, readable.
        let p = at + 4;
        const end = Math.min(packet.length, p + packet.readUInt16BE(at + 2) * 4);
        while (p < end) {
            const byte = packet[p];
            if (byte === 0) {
                p += 1;
                continue;
            }
            const id = byte >> 4;
            if (id === 15) break;
            sent.ids[id] = (sent.ids[id] ?? 0) + 1;
            p += 1 + (byte & 0x0f) + 1;
        }
    }
}

/** Starts one: `portA` is what the first end sends to, `portB` the second. */
export function newForwarder() {
    const a = dgram.createSocket('udp4');
    const b = dgram.createSocket('udp4');
    const proxy = { a, b, first: null, second: null, reach: [], pieces: {}, seen: { stun: 0, dtls: 0, rtp: 0, rtcp: 0, rtp_from: {} } };
    a.on('message', (packet, from) => {
        proxy.first = from;
        read(proxy, 'a_to_b', packet);
        if (proxy.second) b.send(packet, proxy.second.port, proxy.second.address);
    });
    b.on('message', (packet, from) => {
        proxy.second = from;
        read(proxy, 'b_to_a', packet);
        if (proxy.first) a.send(packet, proxy.first.port, proxy.first.address);
        // Before the first end has sent anything here: on to each port it's said to listen on, on this computer and nowhere else.
        else for (const port of proxy.reach) a.send(packet, port, lanAddress);
    });
    return new Promise((resolve) => {
        a.bind(0, '0.0.0.0', () => b.bind(0, '0.0.0.0', () => resolve({
            address: lanAddress,
            portA: a.address().port,
            portB: b.address().port,
            /** What it has read so far. */
            report: () => JSON.parse(JSON.stringify(proxy.seen)),
            /** The ports the first end listens on, on this computer: what the second end sends is passed on to them unasked. @param {number[]} ports */
            reach: (ports) => {
                proxy.reach = ports.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65_535).slice(0, 16);
                return proxy.reach;
            },
            close: () => {
                a.close();
                b.close();
            },
        })));
    });
}

/** A host candidate that points at a forwarder's socket. @param {string} address @param {number} port */
export const candidateFor = (address, port) => `candidate:7 1 udp 2122260223 ${address} ${port} typ host generation 0`;
