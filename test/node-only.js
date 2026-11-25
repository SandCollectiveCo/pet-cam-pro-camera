// Tests that only make sense in Node: what reads this folder's own files.
// run-node.mjs imports this after test/all.js.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { APP_VERSION, PAGE, PAGE_NAME, PAGE_ORIGIN, PAGE_PATH, RELEASE } from '../src/config.js';
import { b64url, fromB64url, textOf, utf8 } from '../src/crypto/bytes.js';
import { build } from '../tools/build.mjs';
import { RELEASE_LIMITS, RELEASE_SIGNED_PREFIX, ReleaseError, checkRelease, checkServed, isListedPath, isPageAddress, makeCheckKey, problemsWithList, releaseDocument, releaseListText, releaseSignedBytes, signRelease, verifyP256 } from '../tools/release.mjs';
import { buildsTheSameTwice, filesIn, problemsForAViewer, problemsIn } from '../tools/verify-build.mjs';
import { assert, suite, test, vectors } from './lib/harness.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under a folder of this one, as paths from the folder's root. @param {string} folder @returns {string[]} */
function filesUnder(folder) {
    const out = [];
    for (const name of readdirSync(path.join(root, folder)).sort()) {
        const relative = `${folder}/${name}`;
        if (statSync(path.join(root, relative)).isDirectory()) out.push(...filesUnder(relative));
        else out.push(relative);
    }
    return out;
}

suite('this folder');

test("only the release's entry may reach for a real camera or microphone", () => {
    // The page's code is handed the browser's devices by whoever starts it
    // (src/main.js, in a release). Nothing else names them: not the rest of
    // the page, and nothing a test or a dev page runs, which feed it a drawn
    // picture instead. dev/guard.js names them to refuse them.
    const allowed = new Set(['src/main.js', 'dev/guard.js']);
    const reaching = /navigator\s*\.\s*mediaDevices|\bgetUserMedia\s*\(|\bgetDisplayMedia\s*\(/;
    const found = [];
    for (const file of [...filesUnder('src'), ...filesUnder('dev'), ...filesUnder('test'), ...filesUnder('tools')]) {
        if (!/\.(js|mjs|html)$/.test(file) || allowed.has(file)) continue;
        const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
        lines.forEach((line, i) => {
            // A line that only says so in words (a comment) asks for nothing.
            const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
            if (!reaching.test(code)) return;
            // The page's own code asks through what it was handed (`this.devices.getUserMedia`), and stand-ins define their own.
            if (/this\.devices\.getUserMedia\(|^\s*async getUserMedia\(/.test(code)) return;
            found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.equal(found, [], 'nothing but src/main.js reaches for the real devices');
});

test('names no machine and nobody who built it', () => {
    // The folder is to stand in a public repository of its own. Whoever runs
    // this is the check: their account's name, their home folder and their
    // machine's name are in none of its files.
    const user = os.userInfo().username;
    const host = os.hostname().replace(/\.local$/, '');
    const marks = [user, os.homedir(), host].filter((mark) => mark.length >= 4);
    const found = [];
    // The public repository's own files are repository/ here, and release/ and .github/ there.
    const folders = ['src', 'dev', 'test', 'tools', 'vectors', 'repository', 'release', '.github'].filter((folder) => existsSync(path.join(root, folder)));
    for (const file of [...folders.flatMap((folder) => filesUnder(folder)), 'package.json', ...readdirSync(root).filter((name) => name.endsWith('.md'))]) {
        const text = readFileSync(path.join(root, file), 'utf8').toLowerCase();
        for (const mark of marks) if (text.includes(mark.toLowerCase())) found.push(file);
    }
    assert.equal(found, []);
});

suite('a release');

test('is the same bytes built twice from the same files', async () => {
    // The second build runs in another process, with another time zone, language and working folder.
    const twice = await buildsTheSameTwice();
    assert.equal(twice.differing, []);
    assert.equal(twice.files.map((file) => file.name.replace(/\.[0-9a-f]{16}\./, '.<hash>.')).sort(), ['camera.<hash>.css', 'camera.<hash>.js', 'index.html', 'release.json']);
});

test("keeps the page's rules, and a build that breaks one is caught", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-test-'));
    try {
        const { files } = await build(folder);
        assert.equal(await problemsIn(folder), []);
        const built = filesIn(folder);
        const script = files.find((file) => file.path.endsWith('.js')).path;
        const page = built.get('index.html').toString('utf8');
        // Each of these is a rule someone could break by hand, or a build could by mistake.
        const breaks = {
            'a byte of the script changed': () => writeFileSync(path.join(folder, script), built.get(script).toString('utf8').replace('Live', 'Lyve')),
            'script written into the page': () => writeFileSync(path.join(folder, 'index.html'), page.replace('</body>', '<script>void 0</script></body>')),
            'a script from another address': () => writeFileSync(path.join(folder, 'index.html'), page.replace('</head>', '<script src="https://example.com/x.js"></script></head>')),
            'a policy that allows inline script': () => writeFileSync(path.join(folder, 'index.html'), page.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")),
            'no integrity on the script': () => writeFileSync(path.join(folder, 'index.html'), page.replace(/ integrity="sha384-[^"]+"><\/script>/, '></script>')),
            'a file the list leaves out': () => writeFileSync(path.join(folder, 'extra.js'), 'void 0;\n'),
            "a file loaded from the origin's root": () => writeFileSync(path.join(folder, 'index.html'), page.replace(`src="${script}"`, `src="/${script}"`)),
            'a base for its addresses': () => writeFileSync(path.join(folder, 'index.html'), page.replace('<title>', '<base href="/"><title>')),
            'something to play a sound with': () => writeFileSync(path.join(folder, script), built.get(script).toString('utf8').replace("this.el('video')", "this.el('audio')")),
            'a signature it never made': () => writeFileSync(path.join(folder, 'release.json'), built.get('release.json').toString('utf8').replace('"signatures": []', '"signatures": [{ "key": "BA", "sig": "AA" }]')),
            'a list for another release': () => writeFileSync(path.join(folder, 'release.json'), built.get('release.json').toString('utf8').replace('\\"release\\":1,', '\\"release\\":2,')),
            'a list for another page': () => writeFileSync(path.join(folder, 'release.json'), built.get('release.json').toString('utf8').replace(`\\"page\\":\\"${PAGE}\\"`, `\\"page\\":\\"${PAGE}petcam/\\"`)),
            'a list with no page': () => writeFileSync(path.join(folder, 'release.json'), built.get('release.json').toString('utf8').replace(`\\"page\\":\\"${PAGE}\\"`, '\\"page\\":null')),
        };
        for (const [what, change] of Object.entries(breaks)) {
            await build(folder);
            change();
            assert.ok((await problemsIn(folder)).length > 0, `not caught: ${what}`);
        }
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test('writes its list as the contract pins one, unsigned', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-test-'));
    try {
        const built = await build(folder);
        const document = JSON.parse(readFileSync(path.join(folder, 'release.json'), 'utf8'));
        assert.equal(Object.keys(document), ['v', 'list', 'signatures']);
        assert.equal([document.v, document.signatures, document.list], [1, [], built.list], 'the list rides as text, and a build signs nothing');
        const list = JSON.parse(document.list);
        assert.equal(Object.keys(list), ['v', 'page', 'release', 'entry', 'files']);
        assert.equal([list.v, list.page, list.release, list.entry], [1, PAGE, RELEASE, 'index.html']);
        assert.equal(APP_VERSION, `web (${RELEASE})`, "a camera's status names the release its list does");
        // Its address is a name of its own and that origin's root: the name, the origin and the path are settings that have to agree, and its address is the three together.
        assert.equal([PAGE_NAME, PAGE_ORIGIN, PAGE_PATH, PAGE], ['camera.petcampro.com', 'https://camera.petcampro.com', '/', 'https://camera.petcampro.com/']);
        assert.equal([PAGE_ORIGIN, PAGE, isPageAddress(PAGE)], [`https://${PAGE_NAME}`, `${PAGE_ORIGIN}${PAGE_PATH}`, true]);
        // It loads its two files by their names alone, which are the names its list has: the same files serve at a root or under any path.
        const html = readFileSync(path.join(folder, 'index.html'), 'utf8');
        assert.equal([...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((found) => found[1]).filter((address) => address !== 'data:,').every((address) => /^camera\.[0-9a-f]{16}\.(?:js|css)$/.test(address)), true);
        for (const file of list.files) assert.equal(Object.keys(file), ['path', 'sha256', 'bytes']);
        assert.equal(list.files.map((file) => file.path.replace(/\.[0-9a-f]{16}\./, '.<hash>.')).sort(), ['camera.<hash>.css', 'camera.<hash>.js', 'index.html']);
        assert.equal(list.files.map((file) => file.path), list.files.map((file) => file.path).sort(), 'in the order of their names, so the same files always make the same text');
        assert.equal(problemsWithList(document.list), []);
        // Under a path, the same files make a list with nothing wrong too, and the same text every time; one that names no page is no viewer's to take.
        assert.equal(problemsWithList(releaseListText({ ...list, page: null })), ['names no page']);
        const named = releaseListText({ ...list, page: 'https://camera.example/petcam/' });
        assert.equal(problemsWithList(named), []);
        assert.equal(named, releaseListText(JSON.parse(named)));
        assert.equal(releaseDocument(named), `${JSON.stringify({ v: 1, list: named, signatures: [] }, null, 2)}\n`);
        assert.equal(RELEASE_SIGNED_PREFIX, 'petcam.release.v1|');
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test('knows a list a viewer would refuse', () => {
    const file = { path: 'index.html', sha256: 'a'.repeat(64), bytes: 163 };
    const good = { v: 1, page: 'https://camera.example/petcam/', release: 3, entry: 'index.html', files: [file] };
    const wrong = (change) => problemsWithList(JSON.stringify({ ...good, ...change })).length > 0;
    assert.equal(problemsWithList(JSON.stringify(good)), []);
    assert.ok(problemsWithList('not json').length > 0 && problemsWithList('[]').length > 0 && problemsWithList('null').length > 0);
    for (const change of [
        { v: 2 }, { page: null }, { page: 'http://camera.example/petcam/' }, { page: 'https://camera.example/petcam' }, { page: 'https://camera.example/petcam/?x=1' }, { page: 'https://camera.example/petcam/#x' },
        { release: 0 }, { release: 2 ** 31 }, { release: 1.5 }, { release: '3' },
        { entry: 'other.html' }, { entry: '../index.html' }, { files: [] }, { files: 'index.html' },
        { files: [file, file] }, { files: Array.from({ length: 65 }, (_, i) => ({ ...file, path: i === 0 ? 'index.html' : `f${i}.js` })) },
        { files: [{ ...file, sha256: 'A'.repeat(64) }] }, { files: [{ ...file, sha256: 'a'.repeat(63) }] },
        { files: [{ ...file, bytes: 8 * 1024 * 1024 + 1 }] }, { files: [{ ...file, bytes: -1 }] }, { files: [{ ...file, bytes: 1.5 }] },
        { entry: 'a/../index.html', files: [{ ...file, path: 'a/../index.html' }] }, { entry: 'in dex.html', files: [{ ...file, path: 'in dex.html' }] },
    ]) assert.ok(wrong(change), JSON.stringify(change).slice(0, 80));
    // 2^31 − 1 is the last release there can be, and 64 files the most.
    assert.equal(problemsWithList(JSON.stringify({ ...good, release: 2 ** 31 - 1, files: Array.from({ length: 64 }, (_, i) => ({ ...file, path: i === 0 ? 'index.html' : `f${i}.js` })) })), []);
    assert.equal([isListedPath('camera.0123456789abcdef.js'), isListedPath('a/b/c.css'), isListedPath('a//b'), isListedPath('/a'), isListedPath('.'), isListedPath('a/..'), isListedPath(`${'a'.repeat(125)}.js`), isListedPath(`${'a'.repeat(126)}.js`)], [true, true, false, false, false, false, true, false]);
    // An address ends in its slash, at a root as under a path.
    assert.equal([isPageAddress('https://camera.example/'), isPageAddress('https://camera.example/petcam/'), isPageAddress('https://camera.example'), isPageAddress('https://camera.example/petcam'), isPageAddress('http://camera.example/'), isPageAddress(null)], [true, true, false, false, false, false]);
});

test('is turned away by a viewer only for being unsigned, and taken once signed, for its own address', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-test-'));
    try {
        const built = await build(folder);
        assert.equal(await problemsForAViewer(folder, { PAGE, RELEASE }), []);
        // The same, step by step, with a key made for this and kept nowhere.
        const key = await makeCheckKey();
        const carries = { keys: [b64url(key.publicKey)], page: PAGE, minimum: RELEASE };
        const code = async (document, how = carries) => (await assert.throws(() => checkRelease(document, how))).code;
        assert.equal(await code(readFileSync(path.join(folder, 'release.json'))), 'not_signed');
        const signed = releaseDocument(built.list, [await signRelease(built.list, key)]);
        const taken = await checkRelease(signed, carries);
        assert.equal([taken.page, taken.release, taken.entry, taken.files.length], [PAGE, RELEASE, 'index.html', 3]);
        // What the folder would serve is what the list gives, the address itself serving the entry.
        const served = Object.fromEntries(filesIn(folder));
        await checkServed(taken, { address: served['index.html'], files: served });
        assert.equal((await assert.throws(() => checkServed(taken, { address: null, files: served }))).code, 'file_missing');
        assert.equal((await assert.throws(() => checkServed(taken, { address: served['index.html'], files: { ...served, 'index.html': Buffer.concat([served['index.html'], Buffer.from('\n')]) } }))).code, 'file_changed');
        // For a build that carries another address, another key, or a later oldest release, it isn't one to take.
        assert.equal(await code(signed, { ...carries, page: 'https://sandcollectiveco.github.io/' }), 'another_page');
        assert.equal(await code(signed, { ...carries, page: PAGE_ORIGIN }), 'another_page', 'the origin with no slash is another address');
        assert.equal(await code(signed, { ...carries, keys: [b64url((await makeCheckKey()).publicKey)] }), 'not_signed');
        assert.equal(await code(signed, { ...carries, minimum: RELEASE + 1 }), 'too_old');
        assert.equal(await code(signed, { ...carries, newestSeen: RELEASE + 1 }), 'older_than_seen');
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

suite('page-release-v1');

/** A build as a case describes one: the keys it carries, by the file's names for them. @param {any} file @param {any} c */
const carriedBy = (file, c) => ({ keys: c.build.keys.map((name) => file.keys[name].public_key), page: c.build.page, minimum: c.build.minimum, newestSeen: c.newest_seen });

/** What checking came to: 'takes' with the release, or the refusal's code. @param {() => Promise<any>} check */
async function verdict(check) {
    try {
        return { expect: 'takes', release: await check() };
    } catch (error) {
        if (!(error instanceof ReleaseError)) throw error;
        return { expect: error.code };
    }
}

test("write a release's list and what its signature is over as the file has them", async () => {
    const file = await vectors('page-release-v1');
    assert.equal([file.signed_prefix, file.limits.document_bytes, file.limits.signatures_read, file.limits.files, file.limits.file_bytes, file.limits.path_characters, file.limits.largest_release],
        [RELEASE_SIGNED_PREFIX, RELEASE_LIMITS.documentBytes, RELEASE_LIMITS.signaturesRead, RELEASE_LIMITS.files, RELEASE_LIMITS.fileBytes, RELEASE_LIMITS.pathLength, RELEASE_LIMITS.release]);
    // From the same files, in the same order, the same text.
    const files = [];
    for (const [name, content] of Object.entries(file.release.files)) {
        const bytes = fromB64url(content);
        files.push({ path: name, bytes: bytes.length, sha256: Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', bytes)).toString('hex') });
    }
    const list = releaseListText({ page: file.page, release: 3, entry: 'index.html', files });
    assert.equal(list, file.release.list);
    assert.equal(textOf(releaseSignedBytes(list)), file.release.signed);
    assert.equal(problemsWithList(list), []);
    // The document's own text is the reader's to parse, not to compare: what it carries is the list as text and its signature.
    assert.equal(JSON.parse(releaseDocument(list, [file.release.signature])), JSON.parse(file.release.document));
    assert.ok(await verifyP256(fromB64url(file.release.signature.key), utf8(file.release.signed), fromB64url(file.release.signature.sig)));
    // Signed here, with the file's made-up key, it is taken as the file's own signature is: r then s, as a release carries it.
    const made = file.keys.release;
    const point = fromB64url(made.public_key);
    const privateKey = await globalThis.crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: made.private_key, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const entry = await signRelease(list, { privateKey, publicKey: point });
    assert.equal([entry.key, fromB64url(entry.sig).length], [made.public_key, 64]);
    assert.equal((await checkRelease(releaseDocument(list, [entry]), { keys: [made.public_key], page: file.page, minimum: 1 })).release, 3);
});

test('check a signature alone as every side does: r then s, 64 bytes, and nothing else', async () => {
    const file = await vectors('page-release-v1');
    for (const c of file.ecdsa.cases) {
        let key = new Uint8Array(0);
        let signature = new Uint8Array(0);
        try {
            key = fromB64url(c.public_key);
            signature = fromB64url(c.signature);
        } catch {
            // Not base64url: nothing to check with.
        }
        assert.equal(await verifyP256(key, utf8(c.message), signature), c.ok, c.why);
    }
    assert.equal(file.ecdsa.cases.length, 10);
});

test('check a release as a viewer does, and turn each one away for what the file says', async () => {
    const file = await vectors('page-release-v1');
    const seen = new Map();
    for (const c of file.checking.cases) {
        const got = await verdict(() => checkRelease(c.document, carriedBy(file, c)));
        assert.equal(got.expect, c.expect, `${c.name}: ${c.why}`);
        if (c.reads) assert.equal([got.release.release, got.release.entry, got.release.files.map((each) => each.path), got.release.page], [c.reads.release, c.reads.entry, c.reads.files, c.build.page], c.name);
        seen.set(c.expect, (seen.get(c.expect) ?? 0) + 1);
        // As its bytes, as a host serves it, it reads the same.
        assert.equal((await verdict(() => checkRelease(utf8(c.document), carriedBy(file, c)))).expect, c.expect, `${c.name}, as bytes`);
    }
    assert.equal(file.checking.cases.length, 77);
    assert.equal([...seen.keys()].sort(), ['another_page', 'not_a_release', 'not_signed', 'older_than_seen', 'takes', 'too_old']);
    // A page at its origin's root is a page like any other: an address is compared whole.
    const byName = Object.fromEntries(file.checking.cases.map((c) => [c.name, c]));
    assert.equal([byName.a_page_at_a_root.build.page, byName.a_page_at_a_root.expect, byName.a_root_for_a_page_with_a_path.expect, byName.a_root_one_slash_short.expect], ['https://camera.example/', 'takes', 'another_page', 'another_page']);
});

test("hold a build's own check of a list to what a viewer makes of one", async () => {
    const file = await vectors('page-release-v1');
    let lists = 0;
    for (const c of file.checking.cases) {
        let outer = null;
        try {
            outer = JSON.parse(c.document);
        } catch {
            // Not a document at all.
        }
        const isADocument = outer !== null && typeof outer === 'object' && !Array.isArray(outer) && outer.v === 1 && typeof outer.list === 'string' && Array.isArray(outer.signatures) && utf8(c.document).length <= RELEASE_LIMITS.documentBytes;
        if (!isADocument) {
            assert.ok(c.expect === 'not_a_release' || c.expect === 'not_signed', c.name);
            continue;
        }
        const problems = problemsWithList(outer.list);
        // A list a viewer takes is one a build may write. One it turns away as no release, though signed, is one the build's check catches.
        if (c.expect === 'takes') assert.equal(problems, [], c.name);
        if (c.expect === 'not_a_release') assert.ok(problems.length > 0, `${c.name}: ${c.why}`);
        // Signed for an address one slash short, the build's check says so before a viewer could say "another page".
        if (c.expect === 'another_page' && !JSON.parse(outer.list).page.endsWith('/')) assert.ok(problems.length > 0, c.name);
        lists += 1;
    }
    assert.ok(lists >= 60);
});

test('hold what a host serves to the list: the address itself, and every file', async () => {
    const file = await vectors('page-release-v1');
    const release = await checkRelease(file.release.document, { keys: [file.keys.release.public_key], page: file.page, minimum: 1 });
    const bytes = (value) => (value === null || value === undefined ? null : fromB64url(value));
    for (const c of file.serving.cases) {
        const served = { address: bytes(c.served.address), files: Object.fromEntries(Object.entries(c.served.files).map(([name, content]) => [name, bytes(content)])) };
        let got = 'served';
        try {
            await checkServed(release, served);
        } catch (error) {
            if (!(error instanceof ReleaseError)) throw error;
            got = error.code;
        }
        assert.equal(got, c.expect, `${c.name}: ${c.why}`);
    }
    assert.equal(file.serving.cases.length, 9);
});
