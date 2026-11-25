// Publishing the page, offline: the release keys file, signing a release
// (with a key made for the test, never the release key), the check the
// public repository's workflow runs before it publishes, the export that
// assembles that repository, the DNS messages the watch sends and reads, and
// what the watch makes of every kind of answer. Nothing here goes on a
// network; tools/watch.mjs run by hand is what asks the real resolvers and
// logs. run-node.mjs imports this after node-only.js.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGE, PAGE_NAME, RELEASE } from '../src/config.js';
import { build } from '../tools/build.mjs';
import { NXDOMAIN, TYPE, addressText, dnsAnswer, dnsQuery, plainAddress } from '../tools/dns.mjs';
import { NotPublishable, checkPublishable } from '../tools/publish-check.mjs';
import { checkRelease, makeCheckKey, readReleaseKeys, releaseDocument, signRelease as signList } from '../tools/release.mjs';
import { SignError, signRelease } from '../tools/sign-release.mjs';
import { HOST, WILDCARD, describeAnswers, judge } from '../tools/watch.mjs';
import { assert, note, suite, test } from './lib/harness.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The release keys file, where this copy of the page keeps it: release/ in the public repository, repository/release/ in the app repository's. */
const keysFile = [path.join(root, 'release', 'keys.json'), path.join(root, 'repository', 'release', 'keys.json')].find((file) => existsSync(file));

/** A temporary folder for `work`, gone afterwards whatever happened. @template T @param {(folder: string) => Promise<T> | T} work */
async function inTemporary(work) {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-publishing-test-'));
    try {
        return await work(folder);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}

/** A built page, its list signed by a key made here, and the keys file naming that key. @param {string} folder */
async function signedBuild(folder) {
    const built = await build(path.join(folder, 'pristine'));
    const key = await makeCheckKey();
    const signature = await signList(built.list, key);
    writeFileSync(path.join(folder, 'keys.json'), JSON.stringify({ keys: [signature.key], oldest: 1 }));
    writeFileSync(path.join(folder, 'release.json'), releaseDocument(built.list, [signature]));
    /** A fresh copy of the build, as the workflow has it. */
    const fresh = () => {
        const dist = path.join(folder, `dist-${Math.random().toString(36).slice(2)}`);
        cpSync(path.join(folder, 'pristine'), dist, { recursive: true });
        return dist;
    };
    return { built, key, signature, fresh, keys: path.join(folder, 'keys.json'), release: path.join(folder, 'release.json') };
}

suite('publishing');

test('reads the release keys file, and refuses anything that isn’t one', async () => {
    const key = (await makeCheckKey()).publicKey;
    const text = Buffer.from(key).toString('base64url');
    assert.equal(readReleaseKeys(JSON.stringify({ keys: [text], oldest: 3 })), { keys: [text], oldest: 3 });
    assert.equal(readReleaseKeys(JSON.stringify({ keys: [] })), { keys: [], oldest: 1 });
    // The file this folder carries until the key is made: no key, and so nothing is published.
    assert.ok(keysFile, 'a release keys file, wherever this copy keeps it');
    assert.ok(Array.isArray(readReleaseKeys(readFileSync(/** @type {string} */ (keysFile), 'utf8')).keys));
    for (const bad of ['', '[]', '{}', JSON.stringify({ keys: ['short'] }), JSON.stringify({ keys: [Buffer.from(key.subarray(1)).toString('base64url')] }), JSON.stringify({ keys: [text, text] }), JSON.stringify({ keys: [text], oldest: 0 }), JSON.stringify({ keys: [text.replace(/^./, '+')] })]) {
        await assert.throws(async () => readReleaseKeys(bad), bad);
    }
});

test('publishes only a build that is exactly a release one of the keys signed', async () => {
    await inTemporary(async (folder) => {
        const s = await signedBuild(folder);
        const ok = await checkPublishable({ dist: s.fresh(), release: s.release, keys: s.keys });
        assert.equal([ok.release, ok.files, ok.live], [RELEASE, s.built.files.length, null]);
        // The signed document takes the unsigned one's place in what's published.
        const dist = s.fresh();
        await checkPublishable({ dist, release: s.release, keys: s.keys });
        assert.equal(readFileSync(path.join(dist, 'release.json'), 'utf8'), readFileSync(s.release, 'utf8'));

        const refused = async (how, expected) => {
            const error = await assert.throws(() => checkPublishable({ dist: s.fresh(), release: s.release, keys: s.keys, ...how }), expected);
            assert.ok(error instanceof NotPublishable && expected.test(error.message), `${expected}: ${error.message}`);
        };
        // No key yet: nothing is published.
        writeFileSync(path.join(folder, 'none.json'), JSON.stringify({ keys: [], oldest: 1 }));
        await refused({ keys: path.join(folder, 'none.json') }, /No release key yet/);
        await refused({ release: path.join(folder, 'missing.json') }, /No signed release document/);
        // Unsigned, or signed by a key that isn't listed.
        writeFileSync(path.join(folder, 'unsigned.json'), releaseDocument(s.built.list));
        await refused({ release: path.join(folder, 'unsigned.json') }, /not_signed/);
        const other = await signList(s.built.list, await makeCheckKey());
        writeFileSync(path.join(folder, 'other.json'), releaseDocument(s.built.list, [other]));
        await refused({ release: path.join(folder, 'other.json') }, /not_signed/);
        // Signed, for another list than this build's (the same files, another release number).
        const another = JSON.stringify({ ...JSON.parse(s.built.list), release: RELEASE + 1 });
        writeFileSync(path.join(folder, 'another.json'), releaseDocument(another, [await signList(another, s.key)]));
        await refused({ release: path.join(folder, 'another.json') }, /isn't the list this build wrote/);
        // A build whose files aren't the signed ones, or that has one more.
        const changed = s.fresh();
        writeFileSync(path.join(changed, 'index.html'), `${readFileSync(path.join(changed, 'index.html'), 'utf8')} `);
        await assert.throws(() => checkPublishable({ dist: changed, release: s.release, keys: s.keys }).then(() => undefined, (error) => {
            assert.ok(/isn't what the signed list says/.test(error.message), error.message);
            throw error;
        }));
        const extra = s.fresh();
        writeFileSync(path.join(extra, 'extra.js'), '1');
        await assert.throws(() => checkPublishable({ dist: extra, release: s.release, keys: s.keys }).then(() => undefined, (error) => {
            assert.ok(/files the signed list doesn't/.test(error.message), error.message);
            throw error;
        }));

        // What the page's address serves now: never older, and the same number only for the same list.
        const serving = (document) => async () => new Response(document, { status: 200 });
        const newer = JSON.stringify({ ...JSON.parse(s.built.list), release: RELEASE + 5 });
        await refused({ live: PAGE, fetch: serving(releaseDocument(newer, [await signList(newer, s.key)])) }, /older than release/);
        const sameNumber = JSON.stringify({ ...JSON.parse(s.built.list), entry: 'index.html', files: JSON.parse(s.built.list).files.slice().reverse() });
        await refused({ live: PAGE, fetch: serving(releaseDocument(sameNumber, [await signList(sameNumber, s.key)])) }, /already served with other files/);
        const same = await checkPublishable({ dist: s.fresh(), release: s.release, keys: s.keys, live: PAGE, fetch: serving(readFileSync(s.release)) });
        assert.ok(same.live === RELEASE && same.notes.some((note) => /publishing it again changes nothing/.test(note)));
        const nothing = await checkPublishable({ dist: s.fresh(), release: s.release, keys: s.keys, live: PAGE, fetch: async () => { throw new TypeError('fetch failed'); } });
        assert.ok(nothing.live === null && nothing.notes.some((note) => /serves no release these keys signed yet/.test(note)));
        const unsignedLive = await checkPublishable({ dist: s.fresh(), release: s.release, keys: s.keys, live: PAGE, fetch: serving(releaseDocument(newer)) });
        assert.equal(unsignedLive.live, null, 'a document no listed key signed is no release to compare with');
    });
});

test('signs a release with the release key, checks it as the apps do, and writes nothing they’d refuse', async () => {
    await inTemporary(async (folder) => {
        const key = await makeCheckKey();
        const publicHalf = Buffer.from(key.publicKey).toString('base64url');
        const keys = path.join(folder, 'keys.json');
        const out = path.join(folder, 'release.json');
        writeFileSync(keys, JSON.stringify({ keys: [publicHalf], oldest: 1 }));
        const asked = [];
        /** The release key's stand-in: what tools/release-key.mjs does with the Secure Enclave's key. */
        const sign = async (list, how) => {
            asked.push(how.reason);
            return signList(list, key);
        };
        const signed = await signRelease({ keys, out, dist: path.join(folder, 'dist'), sign });
        assert.equal([signed.release, signed.page, signed.key, signed.signatures], [RELEASE, PAGE, publicHalf, 1]);
        assert.equal(asked, [`sign release ${RELEASE} of the camera page`]);
        const taken = await checkRelease(readFileSync(out), { keys: [publicHalf], page: PAGE, minimum: 1 });
        assert.equal(taken.release, RELEASE);

        // A second key's signature over the same list is kept beside the first.
        const spare = await makeCheckKey();
        const spareHalf = Buffer.from(spare.publicKey).toString('base64url');
        writeFileSync(keys, JSON.stringify({ keys: [publicHalf, spareHalf], oldest: 1 }));
        const both = await signRelease({ keys, out, dist: path.join(folder, 'dist'), sign: (list) => signList(list, spare) });
        assert.equal(both.signatures, 2);
        assert.equal(JSON.parse(readFileSync(out, 'utf8')).signatures.map((entry) => entry.key), [publicHalf, spareHalf]);

        // A key the apps don't carry: nothing is written.
        writeFileSync(keys, JSON.stringify({ keys: [spareHalf], oldest: 1 }));
        const before = readFileSync(out, 'utf8');
        const unlisted = await assert.throws(() => signRelease({ keys, out: path.join(folder, 'unlisted.json'), dist: path.join(folder, 'dist'), sign }));
        assert.ok(unlisted instanceof SignError && /a key the apps don't carry/.test(unlisted.message), unlisted.message);
        assert.equal(existsSync(path.join(folder, 'unlisted.json')), false);

        // One list a release number: this number signed for other files, or a newer one already there, is refused before anything is signed.
        const list = JSON.parse(JSON.parse(before).list);
        writeFileSync(path.join(folder, 'other.json'), releaseDocument(JSON.stringify({ ...list, files: list.files.slice(1) })));
        const reused = await assert.throws(() => signRelease({ keys, out: path.join(folder, 'other.json'), dist: path.join(folder, 'dist'), sign: (l) => signList(l, spare) }));
        assert.ok(reused instanceof SignError && /already signed for other files/.test(reused.message), reused.message);
        writeFileSync(path.join(folder, 'newer.json'), releaseDocument(JSON.stringify({ ...list, release: RELEASE + 1 })));
        const older = await assert.throws(() => signRelease({ keys, out: path.join(folder, 'newer.json'), dist: path.join(folder, 'dist'), sign: (l) => signList(l, spare) }));
        assert.ok(older instanceof SignError && /newer than this build's/.test(older.message), older.message);
        assert.equal(asked.length, 2, 'refused before the key was asked');
    });
});

test('assembles the public repository from this folder, and nothing of the app repository’s', async () => {
    // The export is the app repository's: the public repository it writes has no repository/ to export from.
    if (!existsSync(path.join(root, 'repository'))) {
        note('the public repository itself: nothing to export from');
        return;
    }
    const { exportPlan, exportRepository } = await import('../tools/export-repository.mjs');
    const plan = exportPlan();
    const files = [...plan.keys()];
    for (const needed of ['README.md', '.github/workflows/publish.yml', '.github/workflows/watch.yml', 'release/keys.json', 'src/main.js', 'tools/build.mjs', 'tools/watch.mjs', 'tools/release-key.swift', 'vectors/temporary-camera-v1.json', 'package.json', 'WORDS.md']) {
        assert.ok(files.includes(needed), needed);
    }
    assert.equal(plan.get('README.md'), path.join(root, 'repository', 'README.md'), 'the public README, never this folder’s own');
    assert.equal(files.filter((file) => /^(dist|\.tmp|node_modules|repository)\b|\.DS_Store$/.test(file) || file === path.join('tools', 'export-repository.mjs')), [], 'nothing of the app repository’s own, the export itself included');
    await inTemporary(async (folder) => {
        const there = path.join(folder, 'checkout');
        const first = exportRepository(there);
        assert.equal([first.written.length, first.removed], [files.length, []]);
        assert.equal(readFileSync(path.join(there, 'README.md'), 'utf8'), readFileSync(path.join(root, 'repository', 'README.md'), 'utf8'));
        // A checkout keeps its git and the watch's record; what an earlier export had and this one doesn't goes.
        mkdirSync(path.join(there, '.git'));
        writeFileSync(path.join(there, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        mkdirSync(path.join(there, 'watch'));
        writeFileSync(path.join(there, 'watch', 'served.json'), '{}\n');
        writeFileSync(path.join(there, 'src', 'gone.js'), '// left by an earlier export\n');
        const again = exportRepository(there);
        assert.equal(again.removed, [path.join('src', 'gone.js')]);
        assert.equal([existsSync(path.join(there, '.git', 'HEAD')), existsSync(path.join(there, 'watch', 'served.json')), existsSync(path.join(there, 'src', 'gone.js'))], [true, true, false]);
        // Anywhere else that isn't empty, nothing is written.
        const elsewhere = path.join(folder, 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(path.join(elsewhere, 'notes.txt'), 'mine');
        await assert.throws(async () => exportRepository(elsewhere));
        assert.equal(existsSync(path.join(elsewhere, 'README.md')), false);
        // And what it wrote builds by itself to the same bytes as this folder.
        const theirs = await import(pathToFileURL(path.join(there, 'tools', 'build.mjs')).href);
        const ours = await build(path.join(folder, 'ours'));
        const exported = await theirs.build(path.join(folder, 'theirs'));
        assert.equal(exported.list, ours.list);
    });
});

suite('the watch');

/** The bytes of a name in a message. @param {string} name */
const nameBytes = (name) => [...name.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]), 0];

/** An answer message: a header, the question, and records whose owner is the question's name (a pointer to it) or given. */
function answerMessage(flags, qname, qtype, records) {
    const bytes = [0, 0, flags >> 8, flags & 0xff, 0, 1, 0, records.length, 0, 0, 0, 0, ...nameBytes(qname), qtype >> 8, qtype & 0xff, 0, 1];
    const offsets = [];
    for (const record of records) {
        const owner = record.owner ?? [0xc0, 0x0c];
        bytes.push(...owner, record.type >> 8, record.type & 0xff, 0, 1, 0, 0, 0x0e, 0x10, record.data.length >> 8, record.data.length & 0xff);
        offsets.push(bytes.length);
        bytes.push(...record.data);
    }
    return { bytes: Uint8Array.from(bytes), offsets };
}

test('asks one name and type as DNS over HTTPS carries it, and reads the answer, names pointing back included', async () => {
    const query = dnsQuery(PAGE_NAME, TYPE.A);
    assert.equal([...query.subarray(0, 12)], [0, 0, 0x01, 0x20, 0, 1, 0, 0, 0, 0, 0, 0], 'id 0, recursion wanted, the AD bit, one question');
    assert.equal([...query.subarray(12)], [...nameBytes(PAGE_NAME), 0, 1, 0, 1]);
    for (const bad of ['', 'a..b', `${'x'.repeat(64)}.example`, 'under_score.example']) await assert.throws(async () => dnsQuery(bad, TYPE.A), `not a name: ${bad}`);
    // A CNAME to GitHub's name, then its addresses, owned by a pointer into the CNAME's own data.
    const first = answerMessage(0x81a0, PAGE_NAME, TYPE.A, [{ type: TYPE.CNAME, data: nameBytes(HOST) }]);
    const cnameData = first.offsets[0];
    const message = answerMessage(0x81a0, PAGE_NAME, TYPE.A, [
        { type: TYPE.CNAME, data: nameBytes(HOST) },
        { owner: [0xc0, cnameData], type: TYPE.A, data: [185, 199, 108, 153] },
        { owner: [0xc0, cnameData], type: TYPE.AAAA, data: [0x26, 0x06, 0x50, 0xc0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x53] },
    ]);
    const read = dnsAnswer(message.bytes);
    assert.equal([read.rcode, read.authenticated, read.truncated], [0, true, false]);
    assert.equal(read.answers.map((r) => [r.name, r.type, r.ttl]), [[PAGE_NAME, TYPE.CNAME, 3600], [HOST, TYPE.A, 3600], [HOST, TYPE.AAAA, 3600]]);
    assert.equal([read.answers[0].target, addressText(read.answers[1].address), addressText(read.answers[2].address)], [HOST, '185.199.108.153', '2606:50c0:8000::153']);
    // No such name.
    const nx = dnsAnswer(answerMessage(0x8183, PAGE_NAME, TYPE.A, []).bytes);
    assert.equal([nx.rcode, nx.answers], [NXDOMAIN, []]);
    // What doesn't read: a query, a message cut short, a name that points at itself.
    for (const bad of [query, message.bytes.subarray(0, message.bytes.length - 3), Uint8Array.from([0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]), new Uint8Array(5)]) {
        let threw = false;
        try {
            dnsAnswer(bad);
        } catch {
            threw = true;
        }
        assert.ok(threw, `refused: ${bad.length} bytes`);
    }
    // An IPv4-mapped IPv6 address is its IPv4; addresses are written as people write them.
    assert.equal([...plainAddress(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4]))], [1, 2, 3, 4]);
    assert.equal(addressText(Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])), '2001:db8::1');
    assert.equal(addressText(Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1])), '2001:db8:1::1:0:1', 'the longest run of zeros, and only it, as ::');
    assert.equal(addressText(Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6])), '2001:db8:1:2:3:4:5:6');
});

/** One resolver's four answers, from a few facts. */
function answers({ name = 'github', signed = true } = {}) {
    const host = { rcode: 0, authenticated: false, truncated: false, answers: [{ name: HOST, type: TYPE.A, ttl: 60, address: Uint8Array.from([185, 199, 108, 153]) }, { name: HOST, type: TYPE.A, ttl: 60, address: Uint8Array.from([185, 199, 109, 153]) }] };
    const hostAAAA = { rcode: 0, authenticated: false, truncated: false, answers: [] };
    const nameAnswers = {
        github: [{ name: PAGE_NAME, type: TYPE.CNAME, ttl: 60, target: HOST }, { name: HOST, type: TYPE.A, ttl: 60, address: Uint8Array.from([185, 199, 108, 153]) }],
        elsewhere: [{ name: PAGE_NAME, type: TYPE.CNAME, ttl: 60, target: 'pages.example.net' }, { name: 'pages.example.net', type: TYPE.A, ttl: 60, address: Uint8Array.from([203, 0, 113, 7]) }],
        proxied: [{ name: PAGE_NAME, type: TYPE.A, ttl: 60, address: Uint8Array.from([104, 21, 0, 1]) }],
        bare: [{ name: PAGE_NAME, type: TYPE.A, ttl: 60, address: Uint8Array.from([185, 199, 108, 153]) }],
        sideways: [{ name: PAGE_NAME, type: TYPE.CNAME, ttl: 60, target: HOST }, { name: HOST, type: TYPE.A, ttl: 60, address: Uint8Array.from([198, 51, 100, 9]) }],
    }[name];
    if (name === 'absent') return { nameA: { rcode: NXDOMAIN, authenticated: false, truncated: false, answers: [] }, nameAAAA: { rcode: NXDOMAIN, authenticated: false, truncated: false, answers: [] }, hostA: host, hostAAAA };
    if (name === 'servfail') return { nameA: { rcode: 2, authenticated: false, truncated: false, answers: [] }, nameAAAA: { rcode: 2, authenticated: false, truncated: false, answers: [] }, hostA: host, hostAAAA };
    return { nameA: { rcode: 0, authenticated: signed, truncated: false, answers: nameAnswers }, nameAAAA: { rcode: 0, authenticated: signed, truncated: false, answers: [] }, hostA: host, hostAAAA };
}

test('says where one resolver says the name points: absent, GitHub’s, or anywhere else', () => {
    const said = (name) => describeAnswers('R', answers({ name }));
    assert.equal([said('absent').outcome, said('github').outcome, said('servfail').outcome], ['absent', 'github', 'failed']);
    assert.equal([said('github').signed, describeAnswers('R', answers({ signed: false })).signed], [true, false]);
    assert.equal(said('github').hostAddresses, ['185.199.108.153', '185.199.109.153']);
    // A CNAME elsewhere; the record proxied through Cloudflare (its addresses, no CNAME); GitHub's addresses with no CNAME; a CNAME to GitHub at an address that isn't its.
    for (const [name, detail] of [['elsewhere', /CNAME to pages\.example\.net/], ['proxied', /104\.21\.0\.1, not one of/], ['bare', /no CNAME to it/], ['sideways', /198\.51\.100\.9, not one of/]]) {
        const d = said(name);
        assert.equal(d.outcome, 'elsewhere', name);
        assert.ok(detail.test(d.detail), `${name}: ${d.detail}`);
    }
});

const NOW = Date.parse('2026-12-01T00:00:00Z');
const DAY = 86_400_000;
/** A certificate as the logs or GitHub's servers give one. */
const certificate = (over = {}) => ({ sha256: 'a'.repeat(64), spkiSha256: 'b'.repeat(64), serial: null, issuer: "Let's Encrypt (C=US, O=Let's Encrypt, CN=R12)", notBefore: new Date(NOW - 10 * DAY).toISOString(), notAfter: new Date(NOW + 80 * DAY).toISOString(), names: [PAGE_NAME], ...over });
const zoneWildcard = certificate({ sha256: 'c'.repeat(64), spkiSha256: 'd'.repeat(64), issuer: 'SSL.com (C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 4)', names: [WILDCARD, 'petcampro.com'] });
const resolvers = (outcome, more = {}) => ['Cloudflare', 'Google', 'Quad9', 'OpenDNS'].map((resolver) => ({ resolver, outcome, detail: outcome, hostAddresses: ['185.199.108.153'], signed: true, ...more }));
/** What the watch makes of it, with everything as it should be unless said. */
const judged = (over = {}) => judge({
    now: NOW, dns: resolvers('github'), served: { state: 'serves', certificate: certificate() },
    logged: { source: 'Cert Spotter', certificates: [certificate(), zoneWildcard] }, record: { served: [] }, page: { state: 'signed', detail: 'release 1, signed' }, ...over,
});
const levels = (result) => result.findings.map((f) => f.level);
const alarms = (result) => result.findings.filter((f) => f.level === 'alarm').map((f) => f.text);

test('says “not there yet” before the name exists, and passes', () => {
    const result = judged({ dns: resolvers('absent'), served: { state: 'skipped' }, logged: { source: 'Cert Spotter', certificates: [zoneWildcard] }, page: null });
    assert.equal(result.verdict, 'not_there_yet');
    assert.ok(result.findings.some((f) => /Not there yet/.test(f.text)));
    assert.ok(result.findings.some((f) => f.level === 'note' && /zone's own wildcard/.test(f.text)), 'the zone’s wildcards are said, not alarmed');
    assert.equal([result.recorded, alarms(result)], [false, []]);
});

test('passes the name as it should be, and records the certificate GitHub serves', () => {
    const result = judged();
    assert.equal([result.verdict, alarms(result), result.recorded], ['ok', [], true]);
    assert.equal(result.record.served.map((c) => [c.sha256, c.firstSeen]), [['a'.repeat(64), new Date(NOW).toISOString()]]);
    // Already recorded: nothing new.
    const again = judged({ record: result.record });
    assert.equal([again.verdict, again.recorded], ['ok', false]);
    // Answers that aren't signed are said: DNSSEC isn't on yet.
    assert.ok(judged({ dns: resolvers('github', { signed: false }) }).findings.some((f) => /DNSSEC/.test(f.text)));
    // Some resolvers have a new record and some don't yet: said, not an alarm.
    const settling = judged({ dns: [...resolvers('github').slice(0, 2), ...resolvers('absent').slice(2)] });
    assert.equal([settling.verdict, alarms(settling)], ['ok', []]);
});

test('raises an alarm for anything about the name that isn’t GitHub’s', () => {
    const cases = [
        ['a resolver says it points elsewhere', { dns: [...resolvers('github').slice(0, 3), { resolver: 'OpenDNS', outcome: 'elsewhere', detail: '104.21.0.1, not one of its addresses' }] }, /OpenDNS says the name points elsewhere/],
        ['a certificate for the name from another authority', { logged: { source: 'Cert Spotter', certificates: [certificate(), certificate({ sha256: 'e'.repeat(64), issuer: 'DigiCert Inc (C=US, O=DigiCert Inc, CN=Encryption Everywhere)' })] } }, /isn't Let's Encrypt's/],
        ['a Let’s Encrypt certificate GitHub never served, past a day', { logged: { source: 'Cert Spotter', certificates: [certificate(), certificate({ sha256: 'f'.repeat(64), spkiSha256: '1'.repeat(64), notBefore: new Date(NOW - 30 * 3_600_000).toISOString() })] } }, /hasn't been seen serving/],
        ['a wildcard covering the name from an authority Cloudflare doesn’t use', { logged: { source: 'Cert Spotter', certificates: [certificate(), certificate({ sha256: '2'.repeat(64), issuer: 'Sectigo (C=GB, O=Sectigo Limited, CN=Sectigo RSA DV)', names: [WILDCARD] })] } }, /wildcard certificate covering the name/],
        ['GitHub serves a certificate that isn’t Let’s Encrypt’s', { served: { state: 'serves', certificate: certificate({ issuer: 'C=US, O=Some CA, CN=X' }) } }, /not Let's Encrypt/],
        ['GitHub serves none any more', { served: { state: 'none', detail: 'no certificate' }, record: { served: [{ ...certificate(), firstSeen: new Date(NOW - 50 * DAY).toISOString() }] } }, /no certificate for the name any more/],
        ['the name points nowhere, with a certificate for it', { dns: resolvers('absent'), served: { state: 'skipped' }, page: null }, /points nowhere/],
        ['the page’s address serves something unsigned', { page: { state: 'unsigned', detail: 'not_signed: no signature' } }, /isn't a signed release/],
    ];
    for (const [what, over, expected] of cases) {
        const result = judged(over);
        assert.equal(result.verdict, 'alarm', what);
        assert.ok(alarms(result).some((text) => expected.test(text)), `${what}: ${alarms(result).join(' | ')}`);
    }
});

test('waits a day for a new certificate GitHub is switching to, and takes one it served before', () => {
    const renewed = certificate({ sha256: '3'.repeat(64), spkiSha256: '4'.repeat(64), notBefore: new Date(NOW - 2 * 3_600_000).toISOString() });
    const pending = judged({ logged: { source: 'Cert Spotter', certificates: [certificate(), renewed] } });
    assert.equal([pending.verdict, alarms(pending)], ['ok', []]);
    assert.ok(pending.findings.some((f) => f.level === 'note' && /doesn't serve yet/.test(f.text)));
    // An older one GitHub served before its renewal is GitHub's: in the record.
    const older = certificate({ sha256: '5'.repeat(64), spkiSha256: '6'.repeat(64), notBefore: new Date(NOW - 60 * DAY).toISOString() });
    const kept = judged({ logged: { source: 'Cert Spotter', certificates: [certificate(), older] }, record: { served: [{ ...older, firstSeen: new Date(NOW - 59 * DAY).toISOString() }] } });
    assert.equal([kept.verdict, alarms(kept)], ['ok', []]);
    // From crt.sh, which gives serial numbers and no hashes, a certificate is matched by its serial.
    const bySerial = judged({ served: { state: 'serves', certificate: certificate({ serial: 'abc123' }) }, logged: { source: 'crt.sh', certificates: [certificate({ sha256: null, spkiSha256: null, serial: 'abc123' })] } });
    assert.equal([bySerial.verdict, alarms(bySerial)], ['ok', []]);
});

test('reads the logs every sixth hour, and an hour without them is no failure', () => {
    const skipped = { skipped: true, detail: 'they’re read every 6 hours, next at 06:00 UTC' };
    const fine = judged({ logged: skipped, record: { served: [{ ...certificate(), firstSeen: new Date(NOW - DAY).toISOString() }] } });
    assert.equal([fine.verdict, alarms(fine)], ['ok', []]);
    assert.ok(fine.findings.some((f) => f.level === 'note' && /weren't read this time/.test(f.text)));
    assert.equal(judged({ logged: skipped, dns: resolvers('absent'), served: { state: 'skipped' }, page: null }).verdict, 'not_there_yet');
    // The resolvers still catch a swap through Cloudflare's proxy in an hour without the logs.
    assert.equal(judged({ logged: skipped, dns: [...resolvers('github').slice(0, 3), { resolver: 'OpenDNS', outcome: 'elsewhere', detail: '104.21.0.1, not one of its addresses' }] }).verdict, 'alarm');
});

test('says it couldn’t look, rather than pass, when nobody answered', () => {
    const silent = judged({ dns: resolvers('failed'), served: { state: 'skipped' } });
    assert.equal(silent.verdict, 'unknown');
    const unlogged = judged({ logged: { failed: true, detail: 'Cert Spotter: answered 503; crt.sh: answered 502' } });
    assert.equal(unlogged.verdict, 'unknown');
    assert.ok(levels(unlogged).includes('unknown'));
    // GitHub's servers out of reach: said, and a pass where every certificate logged is one already recorded; one that isn't can't be told from theirs.
    const recorded = { served: [{ ...certificate(), firstSeen: new Date(NOW - 9 * DAY).toISOString() }] };
    assert.equal(judged({ served: { state: 'failed', detail: 'timeout' }, record: recorded }).verdict, 'ok');
    assert.equal(judged({ served: { state: 'failed', detail: 'timeout' } }).verdict, 'unknown');
    // Serving no certificate before they ever have: said, not an alarm.
    assert.equal(judged({ served: { state: 'none', detail: 'ERR_TLS_CERT_ALTNAME_INVALID' }, logged: { source: 'Cert Spotter', certificates: [zoneWildcard] }, page: null }).verdict, 'ok');
});
