// The watch on the page's name (docs/WEB-CAMERA.md § 2, The page's name),
// run on a schedule by the public repository's workflow (.github/workflows/
// watch.yml there; repository/ here), and by anyone, any time:
//
//   node tools/watch.mjs [--record watch/served.json] [--keys release/keys.json] [--summary <file>] [--logs-every <hours>]
//
// The workflow runs it every hour, and reads the certificate logs every
// sixth (--logs-every 6, on the UTC hours 0, 6, 12 and 18): the resolvers
// and GitHub's servers are what would see a swap made through Cloudflare,
// so they're asked every hour, while a certificate takes hours to show in
// the logs and their free API is shared. Run by hand, it reads everything.
//
// A page under a name of ours can be swapped by whoever can change the name:
// point it at a server of their own, with a certificate of their own. This
// looks from outside Cloudflare, which holds the name, for any sign of that:
//
// - Where the name points, asked of four public resolvers over HTTPS
//   (Cloudflare, Google, Quad9, OpenDNS): a CNAME to GitHub's own name for
//   the organization's pages, and no address that isn't one of its. A
//   record proxied through Cloudflare shows here as Cloudflare's addresses.
// - Which certificate GitHub's own servers serve for the name, asked of them
//   directly, by their addresses.
// - Every certificate logged for the name in the public certificate logs,
//   which Chrome and Safari require of any certificate they take (Cert
//   Spotter's API, then crt.sh's). One for the name itself is GitHub's only
//   if it's Let's Encrypt's and GitHub has been seen serving it (the record,
//   below), or it's under a day old and GitHub is still switching to it.
//   The zone's own wildcard certificates (Cloudflare's, for petcampro.com
//   and every name one level under it) cover the name too: they're reported,
//   and only one from another authority than Cloudflare's is an alarm, since
//   they serve the name only through Cloudflare's own proxy, which the
//   resolvers above would show.
// - Once the page is there: that what its address serves is a release
//   signed by a key in release/keys.json, every file as listed.
//
// The record (watch/served.json in the public repository) is every
// certificate GitHub has been seen serving for the name: the watch adds to
// it, and the workflow commits it. Before the name exists anywhere, and with
// no certificate logged for it, it says "not there yet" and passes.
//
// It sends nothing but the page's public name, to public services. Exit 0:
// as it should be, or not there yet. 1: an alarm. 2: it couldn't look (no
// resolver answered, or the logs couldn't be read). The workflow fails on 1
// and 2, and a failed run mails the repository's admins.

import { X509Certificate, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { PAGE, PAGE_NAME } from '../src/config.js';
import { NXDOMAIN, TYPE, addressText, dnsAnswer, dnsQuery, plainAddress } from './dns.mjs';
import { ReleaseError, checkRelease, checkServed, readReleaseKeys } from './release.mjs';

/** GitHub's own name for the organization's pages, which the page's name is a CNAME to (TemporaryCamera.pageHost in the apps). */
export const HOST = 'sandcollectiveco.github.io';
/** Four operators' public resolvers, each asked over HTTPS (RFC 8484). */
export const RESOLVERS = Object.freeze([
    Object.freeze({ name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' }),
    Object.freeze({ name: 'Google', url: 'https://dns.google/dns-query' }),
    Object.freeze({ name: 'Quad9', url: 'https://dns.quad9.net/dns-query' }),
    Object.freeze({ name: 'OpenDNS', url: 'https://doh.opendns.com/dns-query' }),
]);
/** The wildcard one level up, which covers the name. */
export const WILDCARD = `*.${PAGE_NAME.split('.').slice(1).join('.')}`;
/** How long a new certificate for the name may go unserved before it's an alarm: GitHub switches to one it renewed within that. */
export const GRACE_MS = 24 * 3_600_000;
/** GitHub Pages' certificates for a customer's name: Let's Encrypt's. */
const GITHUB_ISSUER = /Let's Encrypt/;
/** The certificate authorities Cloudflare's own certificates for the zone come from (read in the logs on 2026-11-25). */
const ZONE_ISSUERS = [/Let's Encrypt/, /Google Trust Services/, /SSL\.com|SSL Corporation/];

/** @param {Uint8Array} a @param {Uint8Array} b */
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
/** @param {Uint8Array | Buffer | string} data */
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
/** A serial number as hex, lowercase, with no leading zeros. @param {unknown} serial */
const serialOf = (serial) => (typeof serial === 'string' ? serial.toLowerCase().replace(/[^0-9a-f]/g, '').replace(/^0+/, '') || null : null);

// ---- Where the name points ---------------------------------------------------

/** @param {{ name: string, url: string }} resolver @param {string} name @param {number} type @param {typeof fetch} fetchFn */
async function ask(resolver, name, type, fetchFn) {
    const query = Buffer.from(dnsQuery(name, type)).toString('base64url');
    const answer = await fetchFn(`${resolver.url}?dns=${query}`, { headers: { accept: 'application/dns-message' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!answer.ok) throw new Error(`answered ${answer.status}`);
    return dnsAnswer(new Uint8Array(await answer.arrayBuffer()));
}

/**
 * What one resolver's answers say of the name.
 * @param {string} resolver
 * `signed` is whether the resolver checked the name's own record with
 * DNSSEC: the answer to a CNAME question, which is the domain's and signed
 * with it. The addresses' answers never are, whatever the domain does: they
 * end in github.io, which isn't signed.
 * @param {{ nameA: ReturnType<typeof dnsAnswer>, nameAAAA: ReturnType<typeof dnsAnswer>, hostA: ReturnType<typeof dnsAnswer>, hostAAAA: ReturnType<typeof dnsAnswer>, nameCNAME?: ReturnType<typeof dnsAnswer> }} answers
 * @returns {{ resolver: string, outcome: 'absent' | 'github' | 'elsewhere' | 'failed', detail: string, hostAddresses?: string[], signed?: boolean }}
 */
export function describeAnswers(resolver, answers) {
    const { nameA, nameAAAA, hostA, hostAAAA, nameCNAME } = answers;
    for (const answer of [nameA, nameAAAA, hostA, hostAAAA, ...(nameCNAME ? [nameCNAME] : [])]) {
        if (answer.rcode !== 0 && answer.rcode !== NXDOMAIN) return { resolver, outcome: 'failed', detail: `it answered with response code ${answer.rcode}` };
    }
    if (nameA.rcode === NXDOMAIN || nameAAAA.rcode === NXDOMAIN) return { resolver, outcome: 'absent', detail: 'no such name' };
    const records = [...nameA.answers, ...nameAAAA.answers];
    const cname = records.find((record) => record.type === TYPE.CNAME && record.name === PAGE_NAME)?.target ?? null;
    const addresses = records.filter((record) => record.address).map((record) => plainAddress(/** @type {Uint8Array} */ (record.address)));
    const host = [...hostA.answers, ...hostAAAA.answers].filter((record) => record.address).map((record) => plainAddress(/** @type {Uint8Array} */ (record.address)));
    if (cname === null && addresses.length === 0) return { resolver, outcome: 'absent', detail: 'no record for the name' };
    if (cname !== null && cname !== HOST) return { resolver, outcome: 'elsewhere', detail: `a CNAME to ${cname}, not to ${HOST}` };
    if (host.length === 0) return { resolver, outcome: 'failed', detail: `no address for ${HOST}` };
    const foreign = addresses.filter((address) => !host.some((own) => sameBytes(address, own)));
    if (foreign.length > 0) return { resolver, outcome: 'elsewhere', detail: `${foreign.map(addressText).join(', ')}, not one of ${HOST}'s addresses` };
    if (cname === null) return { resolver, outcome: 'elsewhere', detail: `${HOST}'s addresses with no CNAME to it: not the record the page's name is` };
    return { resolver, outcome: 'github', detail: `a CNAME to ${HOST}, ${addresses.map(addressText).join(', ')}`, hostAddresses: host.map(addressText), signed: (nameCNAME ?? nameA).authenticated };
}

/** @param {{ name: string, url: string }} resolver @param {typeof fetch} [fetchFn] */
export async function whereItPoints(resolver, fetchFn = fetch) {
    try {
        const [nameA, nameAAAA, hostA, hostAAAA, nameCNAME] = await Promise.all([
            ask(resolver, PAGE_NAME, TYPE.A, fetchFn), ask(resolver, PAGE_NAME, TYPE.AAAA, fetchFn), ask(resolver, HOST, TYPE.A, fetchFn), ask(resolver, HOST, TYPE.AAAA, fetchFn), ask(resolver, PAGE_NAME, TYPE.CNAME, fetchFn),
        ]);
        return describeAnswers(resolver.name, { nameA, nameAAAA, hostA, hostAAAA, nameCNAME });
    } catch (error) {
        return { resolver: resolver.name, outcome: /** @type {const} */ ('failed'), detail: `no answer: ${error?.message ?? error}` };
    }
}

// ---- What GitHub's servers serve for it --------------------------------------

/** @typedef {{ sha256: string | null, spkiSha256: string | null, serial: string | null, issuer: string, notBefore: string, notAfter: string, names: string[], revoked?: boolean }} Certificate */

/** @param {X509Certificate} certificate @returns {Certificate} */
export function describeCertificate(certificate) {
    return {
        sha256: sha256hex(certificate.raw),
        spkiSha256: sha256hex(certificate.publicKey.export({ type: 'spki', format: 'der' })),
        serial: serialOf(certificate.serialNumber),
        issuer: certificate.issuer.replace(/\n/g, ', '),
        notBefore: new Date(certificate.validFrom).toISOString(),
        notAfter: new Date(certificate.validTo).toISOString(),
        names: (certificate.subjectAltName ?? '').split(', ').filter((entry) => entry.startsWith('DNS:')).map((entry) => entry.slice(4).toLowerCase()),
    };
}

/** Errors that mean the server answered, with a certificate that isn't good for the name. */
const NOT_FOR_THE_NAME = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID']);

/**
 * The certificate GitHub's servers serve for the name, asked of them by
 * their own addresses, the name given as the server name, checked as a
 * browser checks one.
 * @param {string[]} addresses GitHub's, as the resolvers gave them
 * @returns {Promise<{ state: 'serves', certificate: Certificate } | { state: 'none' | 'failed', detail: string }>}
 */
export async function servedCertificate(addresses) {
    const ordered = [...addresses.filter((a) => a.includes('.')), ...addresses.filter((a) => a.includes(':'))];
    let last = 'no address to ask';
    for (const address of ordered) {
        const result = await new Promise((resolve) => {
            const socket = tls.connect({ host: address, port: 443, servername: PAGE_NAME, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
            socket.setTimeout(15_000, () => {
                socket.destroy();
                resolve({ state: 'failed', detail: `${address} didn't answer in time` });
            });
            socket.once('secureConnect', () => {
                const peer = socket.getPeerX509Certificate();
                socket.end();
                resolve(peer ? { state: 'serves', certificate: describeCertificate(peer) } : { state: 'none', detail: `${address} gave no certificate` });
            });
            socket.once('error', (error) => {
                socket.destroy();
                resolve(NOT_FOR_THE_NAME.has(error.code) ? { state: 'none', detail: `${address} serves no certificate for the name (${error.code})` } : { state: 'failed', detail: `${address}: ${error.code ?? error.message}` });
            });
        });
        if (result.state !== 'failed') return result;
        last = result.detail;
    }
    return { state: 'failed', detail: last };
}

// ---- What the certificate logs hold for it -------------------------------------

/** @param {any} entry @returns {Certificate} */
const fromCertSpotter = (entry) => ({
    sha256: typeof entry.cert_sha256 === 'string' ? entry.cert_sha256.toLowerCase() : null,
    spkiSha256: typeof entry.pubkey_sha256 === 'string' ? entry.pubkey_sha256.toLowerCase() : null,
    serial: null,
    issuer: `${entry.issuer?.friendly_name ?? ''} (${entry.issuer?.name ?? ''})`,
    notBefore: entry.not_before,
    notAfter: entry.not_after,
    names: (entry.dns_names ?? []).map((name) => String(name).toLowerCase()),
    revoked: entry.revoked === true,
});

/** @param {any} entry @returns {Certificate} */
const fromCrtSh = (entry) => ({
    sha256: null,
    spkiSha256: null,
    serial: serialOf(entry.serial_number),
    issuer: String(entry.issuer_name ?? ''),
    notBefore: new Date(`${entry.not_before}Z`).toISOString(),
    notAfter: new Date(`${entry.not_after}Z`).toISOString(),
    names: String(entry.name_value ?? '').split('\n').map((name) => name.trim().toLowerCase()).filter(Boolean),
});

const SOURCES = [
    {
        name: 'Cert Spotter',
        /** @param {typeof fetch} fetchFn */
        async read(fetchFn) {
            const all = [];
            let after = null;
            for (let page = 0; page < 20; page++) {
                const url = new URL('https://api.certspotter.com/v1/issuances');
                url.searchParams.set('domain', PAGE_NAME);
                url.searchParams.set('match_wildcards', 'true');
                url.searchParams.append('expand', 'dns_names');
                url.searchParams.append('expand', 'issuer');
                if (after) url.searchParams.set('after', after);
                const answer = await fetchFn(url.href, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
                if (!answer.ok) throw new Error(`answered ${answer.status}`);
                const list = await answer.json();
                if (!Array.isArray(list)) throw new Error('not a list of issuances');
                all.push(...list.map(fromCertSpotter));
                if (list.length === 0 || !list.at(-1)?.id) break;
                after = String(list.at(-1).id);
            }
            return all;
        },
    },
    {
        name: 'crt.sh',
        /** @param {typeof fetch} fetchFn */
        async read(fetchFn) {
            const all = [];
            for (const q of [PAGE_NAME, WILDCARD]) {
                const answer = await fetchFn(`https://crt.sh/?q=${encodeURIComponent(q)}&output=json&exclude=expired`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
                if (!answer.ok) throw new Error(`answered ${answer.status}`);
                const list = await answer.json();
                if (!Array.isArray(list)) throw new Error('not a list of certificates');
                all.push(...list.map(fromCrtSh));
            }
            return all;
        },
    },
];

/** Every certificate logged for the name, wildcards covering it included, from the first source that answers. @param {typeof fetch} [fetchFn] */
export async function loggedCertificates(fetchFn = fetch) {
    const failures = [];
    for (const source of SOURCES) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                return { source: source.name, certificates: await source.read(fetchFn) };
            } catch (error) {
                failures.push(`${source.name}: ${error?.message ?? error}`);
            }
        }
    }
    return { failed: /** @type {const} */ (true), detail: failures.join('; ') };
}

// ---- What the page's address serves ---------------------------------------------

/**
 * Whether what the page's address serves is a release signed by one of the
 * release keys, every file as listed: what the apps check before a code shows.
 * @param {{ keys: string[], oldest: number } | null} known @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ state: 'signed' | 'unsigned' | 'absent' | 'failed' | 'no_keys', detail: string }>}
 */
export async function servedRelease(known, fetchFn = fetch) {
    if (!known || known.keys.length === 0) return { state: 'no_keys', detail: 'no release key yet to check it with' };
    const get = async (address) => {
        const answer = await fetchFn(address, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
        return answer.ok ? new Uint8Array(await answer.arrayBuffer()) : null;
    };
    try {
        const document = await get(`${PAGE}release.json`);
        if (!document) return { state: 'absent', detail: `${PAGE}release.json isn't there` };
        const release = await checkRelease(document, { keys: known.keys, page: PAGE, minimum: known.oldest });
        const files = {};
        for (const file of release.files) files[file.path] = await get(`${PAGE}${file.path}`);
        await checkServed(release, { address: await get(PAGE), files });
        return { state: 'signed', detail: `release ${release.release}, signed, every file as listed` };
    } catch (error) {
        if (error instanceof ReleaseError) return { state: 'unsigned', detail: `${error.code}: ${error.message}` };
        return { state: 'failed', detail: String(error?.message ?? error) };
    }
}

// ---- What it all comes to ---------------------------------------------------------

/** @param {Certificate} a @param {{ sha256?: string | null, spkiSha256?: string | null, serial?: string | null, notBefore?: string }} b */
function same(a, b) {
    if (a.sha256 && b.sha256) return a.sha256 === b.sha256;
    if (a.serial && b.serial) return a.serial === b.serial;
    return Boolean(a.spkiSha256 && b.spkiSha256 && a.spkiSha256 === b.spkiSha256 && a.notBefore === b.notBefore);
}

/**
 * What the watch makes of what it found, and the record as it should be after.
 * @param {{
 *   now: number,
 *   dns: ReturnType<typeof describeAnswers>[],
 *   served: Awaited<ReturnType<typeof servedCertificate>> | { state: 'skipped' },
 *   logged: Awaited<ReturnType<typeof loggedCertificates>> | { skipped: true, detail: string },
 *   record: { served: (Certificate & { firstSeen: string })[] },
 *   page?: Awaited<ReturnType<typeof servedRelease>> | null,
 * }} found
 * @returns {{ verdict: 'ok' | 'not_there_yet' | 'alarm' | 'unknown', findings: { level: 'ok' | 'note' | 'alarm' | 'unknown', text: string }[], record: { served: (Certificate & { firstSeen: string })[] }, recorded: boolean }}
 */
export function judge(found) {
    const findings = [];
    const say = (level, text) => findings.push({ level, text });
    const record = { served: [...found.record.served] };
    let recorded = false;

    // Where the name points.
    const answered = found.dns.filter((d) => d.outcome !== 'failed');
    const here = found.dns.filter((d) => d.outcome === 'github');
    for (const d of found.dns) {
        if (d.outcome === 'elsewhere') say('alarm', `${d.resolver} says the name points elsewhere: ${d.detail}.`);
        else if (d.outcome === 'failed') say('note', `${d.resolver} didn't answer: ${d.detail}.`);
    }
    if (answered.length === 0) say('unknown', 'No resolver answered: where the name points is unknown.');
    else if (here.length === answered.length) say('ok', `All ${here.length} resolvers that answered say the name is a CNAME to ${HOST}, at its addresses.`);
    else if (here.length > 0 && found.dns.some((d) => d.outcome === 'absent')) say('note', 'Some resolvers have the name and some don’t yet: a new record takes up to half an hour to reach them all.');
    const checked = here.filter((d) => d.signed).length;
    if (here.length > 0 && checked === 0) say('note', 'The name’s record isn’t signed, or no resolver checked it: DNSSEC isn’t holding for it.');
    else if (checked > 0) say('ok', `The name’s record is signed: DNSSEC holds for it at ${checked === here.length ? `all ${checked} resolvers` : `${checked} of ${here.length} resolvers (the rest don’t check)`}. GitHub’s own addresses aren’t signed: github.io isn’t.`);
    const absentEverywhere = answered.length > 0 && answered.every((d) => d.outcome === 'absent');

    // What GitHub serves for it.
    const served = found.served.state === 'serves' ? found.served.certificate : null;
    if (served) {
        if (!GITHUB_ISSUER.test(served.issuer)) say('alarm', `GitHub's servers serve the name a certificate from ${served.issuer}, not Let's Encrypt.`);
        else say('ok', `GitHub's servers serve the name a certificate from ${served.issuer}, valid until ${served.notAfter.slice(0, 10)}.`);
        if (!record.served.some((known) => same(known, served))) {
            record.served.push({ ...served, firstSeen: new Date(found.now).toISOString() });
            recorded = true;
            say('note', 'A certificate GitHub hadn’t been seen serving before: added to the record.');
        }
    } else if (found.served.state === 'none') {
        if (record.served.length > 0) say('alarm', `GitHub's servers serve no certificate for the name any more: ${found.served.detail}.`);
        else if (here.length > 0) say('note', `GitHub's servers serve no certificate for the name yet (${found.served.detail}): it makes one once the name points at it, within the hour as a rule.`);
    } else if (found.served.state === 'failed') say('note', `GitHub's servers couldn't be asked: ${found.served.detail}.`);

    // What the logs hold.
    let exact = [];
    if ('failed' in found.logged) say('unknown', `The certificate logs couldn't be read: ${found.logged.detail}.`);
    else if ('skipped' in found.logged) say('note', `The certificate logs weren't read this time: ${found.logged.detail}.`);
    else {
        const live = found.logged.certificates.filter((c) => !c.revoked && Date.parse(c.notAfter) > found.now);
        exact = live.filter((c) => c.names.includes(PAGE_NAME));
        const wildcards = live.filter((c) => !c.names.includes(PAGE_NAME) && c.names.includes(WILDCARD));
        let theirs = 0;
        for (const c of exact) {
            const when = `issued ${c.notBefore.slice(0, 16).replace('T', ' ')} UTC by ${c.issuer}`;
            if (!GITHUB_ISSUER.test(c.issuer)) say('alarm', `A certificate for the name that isn't Let's Encrypt's, so not GitHub's: ${when}${c.sha256 ? `, SHA-256 ${c.sha256}` : ''}.`);
            else if ((served && same(c, served)) || record.served.some((known) => same(c, known))) theirs += 1;
            else if (found.now - Date.parse(c.notBefore) < GRACE_MS) say('note', `A new certificate for the name GitHub doesn't serve yet (${when}): it may still be switching to it. An alarm if it hasn't within a day.`);
            else if (!served && found.served.state !== 'none' && !absentEverywhere) say('unknown', `A certificate for the name that isn't in the record, and GitHub's servers couldn't be asked to compare it with theirs: ${when}${c.sha256 ? `, SHA-256 ${c.sha256}` : ''}.`);
            else say('alarm', `A certificate for the name that GitHub hasn't been seen serving: ${when}${c.sha256 ? `, SHA-256 ${c.sha256}` : ''}.`);
        }
        const strange = wildcards.filter((c) => !ZONE_ISSUERS.some((issuer) => issuer.test(c.issuer)));
        for (const c of strange) say('alarm', `A wildcard certificate covering the name from an authority Cloudflare doesn't use for the zone: ${c.names.join(', ')}, ${c.issuer}, ${c.notBefore.slice(0, 10)}.`);
        if (wildcards.length > strange.length) {
            say('note', `${wildcards.length - strange.length} of the zone's own wildcard certificates (${WILDCARD}, Cloudflare's) cover the name. They serve it only through Cloudflare's own proxy, which would show above as Cloudflare's addresses.`);
        }
        if (exact.length > 0 && theirs === exact.length) say('ok', `Every certificate logged for the name (${exact.length}, from ${found.logged.source}) is one GitHub has served.`);
        else if (exact.length === 0) say('ok', `No certificate is logged for the name itself (${found.logged.source}).`);
    }

    // What its address serves.
    if (found.page) {
        if (found.page.state === 'signed') say('ok', `The page's address serves ${found.page.detail}.`);
        else if (found.page.state === 'unsigned') say('alarm', `The page's address serves something that isn't a signed release: ${found.page.detail}.`);
        else if (found.page.state === 'absent') say('note', `The page's address serves no release yet: ${found.page.detail}.`);
        else if (found.page.state === 'failed') say('note', `The page's address couldn't be read: ${found.page.detail}.`);
    }

    // Not there yet: no record anywhere, nothing logged for the name, and never served.
    if (absentEverywhere) {
        if (exact.length > 0 || record.served.length > 0) say('alarm', 'The name points nowhere, though it has a certificate or GitHub has served one: it was taken down, or someone got a certificate for it.');
        else say('ok', `Not there yet: no resolver has the name${'certificates' in found.logged ? ', no certificate for it is logged,' : ''} and GitHub has never served one.`);
    }

    const levels = new Set(findings.map((f) => f.level));
    const verdict = levels.has('alarm') ? 'alarm' : levels.has('unknown') ? 'unknown' : absentEverywhere ? 'not_there_yet' : 'ok';
    return { verdict, findings, record, recorded };
}

// ---- Run ----------------------------------------------------------------------------

/** @param {string | null} file */
function readRecord(file) {
    if (!file || !existsSync(file)) return { served: [] };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { served: Array.isArray(parsed.served) ? parsed.served : [] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name) => {
        const at = args.indexOf(`--${name}`);
        return at >= 0 ? args[at + 1] : null;
    };
    const recordFile = option('record');
    // The release keys: given, or wherever this copy of the page keeps them (release/ in its public repository, repository/release/ in the app repository's).
    const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const keysFile = option('keys') ?? [path.join(folder, 'release', 'keys.json'), path.join(folder, 'repository', 'release', 'keys.json')].find((file) => existsSync(file)) ?? null;
    const summaryFile = option('summary');
    const record = readRecord(recordFile);
    const known = keysFile && existsSync(keysFile) ? readReleaseKeys(readFileSync(keysFile, 'utf8')) : null;

    const dns = await Promise.all(RESOLVERS.map((resolver) => whereItPoints(resolver)));
    const here = dns.filter((d) => d.outcome === 'github');
    const addresses = [...new Set(here.flatMap((d) => d.hostAddresses ?? []))];
    const served = here.length > 0 ? await servedCertificate(addresses) : /** @type {const} */ ({ state: 'skipped' });
    const every = Number(option('logs-every') ?? 1);
    const hour = new Date().getUTCHours();
    const logged = every > 1 && hour % every !== 0
        ? /** @type {const} */ ({ skipped: true, detail: `they're read every ${every} hours, next at ${String(Math.ceil((hour + 1) / every) * every % 24).padStart(2, '0')}:00 UTC` })
        : await loggedCertificates();
    const page = served.state === 'serves' ? await servedRelease(known) : null;
    const result = judge({ now: Date.now(), dns, served, logged, record, page });

    const mark = { ok: '✓', note: '·', alarm: '✗', unknown: '?' };
    const heading = { ok: `${PAGE_NAME}: as it should be.`, not_there_yet: `${PAGE_NAME}: not there yet.`, alarm: `${PAGE_NAME}: ALARM. Something about the name isn't GitHub's.`, unknown: `${PAGE_NAME}: couldn't look.` }[result.verdict];
    console.log(heading);
    for (const f of result.findings) console.log(`  ${mark[f.level]} ${f.text}`);
    for (const d of dns) console.log(`    ${d.resolver}: ${d.outcome}, ${d.detail}`);
    if (recordFile && result.recorded) {
        mkdirSync(path.dirname(recordFile), { recursive: true });
        writeFileSync(recordFile, `${JSON.stringify({ about: 'Every certificate GitHub’s servers have been seen serving for the page’s name, by tools/watch.mjs. A certificate logged for the name that isn’t here, and that GitHub doesn’t serve within a day, is an alarm.', name: PAGE_NAME, served: result.record.served }, null, 2)}\n`);
    }
    if (summaryFile) {
        appendFileSync(summaryFile, `### ${heading}\n\n${result.findings.map((f) => `- ${mark[f.level]} ${f.text}`).join('\n')}\n\n${dns.map((d) => `- ${d.resolver}: ${d.outcome}, ${d.detail}`).join('\n')}\n`);
    }
    process.exitCode = result.verdict === 'alarm' ? 1 : result.verdict === 'unknown' ? 2 : 0;
}
