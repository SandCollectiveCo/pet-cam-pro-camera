// Checks a build against the page's rules (docs/WEB-CAMERA.md § 2), and
// that building is repeatable:
//
//   node tools/verify-build.mjs
//
// builds twice, the second time in another process with another time zone,
// language and working directory, compares the two byte for byte, and goes
// over what came out. `problemsIn` is the going over, for a test to hold a
// build to as well.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './build.mjs';
import { RELEASE_LIMITS, ReleaseError, checkRelease, checkServed, makeCheckKey, problemsWithList, releaseDocument, signRelease } from './release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every file in a folder, by name, with its bytes. @param {string} folder @returns {Map<string, Buffer>} */
export function filesIn(folder) {
    return new Map(readdirSync(folder).sort().map((name) => [name, readFileSync(path.join(folder, name))]));
}

/** Builds twice, apart, and says whether the two are the same bytes. */
export async function buildsTheSameTwice() {
    const first = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-build-a-'));
    const second = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-build-b-'));
    try {
        await build(first);
        // Again, somewhere else in every way a build might pick up: another process, clock zone, language and folder.
        execFileSync(process.execPath, [path.join(here, 'build.mjs'), second], { cwd: os.tmpdir(), env: { ...process.env, TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }, stdio: 'ignore' });
        const a = filesIn(first);
        const b = filesIn(second);
        const differing = [...new Set([...a.keys(), ...b.keys()])].filter((name) => !a.has(name) || !b.has(name) || !a.get(name).equals(b.get(name)));
        return { same: differing.length === 0, differing, files: [...a].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
    } finally {
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
    }
}

/**
 * What's wrong with a build, as a list of plain sentences: empty when it
 * keeps every rule.
 * @param {string} folder a build's folder
 * @returns {Promise<string[]>}
 */
export async function problemsIn(folder) {
    const problems = [];
    const files = filesIn(folder);
    const config = await import(pathToFileURL(path.join(here, '..', 'src', 'config.js')).href);
    const api = new URL(config.API);
    const text = (name) => files.get(name)?.toString('utf8') ?? '';
    const page = text('index.html');
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const sheets = [...page.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
    const sri = (bytes) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

    // ---- The page itself ----
    if (scripts.length !== 1) problems.push(`index.html has ${scripts.length} scripts: it has one`);
    for (const [, attributes, inside] of scripts) {
        if (inside.trim() !== '') problems.push('index.html has script written into it');
        const from = attribute(attributes, 'src');
        if (!from || !files.has(from)) problems.push(`index.html loads a script that isn't in the build: ${from}`);
        else if (attribute(attributes, 'integrity') !== sri(files.get(from))) problems.push(`index.html's integrity for ${from} isn't that file's hash`);
    }
    if (sheets.length !== 1) problems.push(`index.html has ${sheets.length} stylesheets: it has one`);
    for (const [tag] of sheets) {
        const from = attribute(tag, 'href');
        if (!from || !files.has(from)) problems.push(`index.html loads a stylesheet that isn't in the build: ${from}`);
        else if (attribute(tag, 'integrity') !== sri(files.get(from))) problems.push(`index.html's integrity for ${from} isn't that file's hash`);
    }
    if (/<style\b|\sstyle="|\son[a-z]+="/i.test(page)) problems.push('index.html has a style or a handler written into it');
    if (/\b(?:src|href)="(?:https?:)?\/\//i.test(page)) problems.push('index.html loads something from another address');
    // Every address the page loads is a file's name alone, relative to its own: the names its list has, and the same files whether it's served at a root or under a path.
    if (/\b(?:src|href|action)="\//i.test(page) || /<base\b/i.test(page)) problems.push("index.html loads something by an address that starts at the origin's root, not by its name alone, or sets a base");
    if (/\{\{|\}\}/.test(page)) problems.push('index.html has a blank left unfilled');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)?.[1] ?? '';
    const directives = new Map(csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(' ')]));
    const wanted = {
        'default-src': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'connect-src': `${api.origin} wss://${api.host}`,
        'base-uri': "'none'", 'form-action': "'none'", 'require-trusted-types-for': "'script'", 'trusted-types': "'none'",
    };
    for (const [name, value] of Object.entries(wanted)) if (directives.get(name) !== value) problems.push(`the policy's ${name} is "${directives.get(name) ?? ''}", not "${value}"`);
    if (/unsafe-inline|unsafe-eval|\*/.test(csp)) problems.push('the policy allows inline script, eval or any address');
    if (page.indexOf('Content-Security-Policy') > page.indexOf('<link') || page.indexOf('Content-Security-Policy') > page.indexOf('<script')) problems.push('the policy comes after something it should govern');

    // ---- The script ----
    const scriptName = [...files.keys()].find((name) => name.endsWith('.js'));
    const whole = text(scriptName ?? '');
    // What runs, without what only explains: the page's comments name things
    // (a type's file, the browser's own devices) that its code never touches.
    const script = whole.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([;,{}()\]]) +\/\/ .*$/gm, '$1');
    const forbidden = {
        'eval(': /\beval\s*\(/, 'new Function': /\bnew\s+Function\b/, 'a service worker': /serviceWorker|importScripts/, 'a worker': /\bnew\s+(Shared)?Worker\b/,
        'innerHTML or the like': /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/, 'a dynamic import': /\bimport\s*\(/, 'a timer given text': /set(Timeout|Interval)\(\s*['"`]/,
        "a test's stand-in": /ANY_SUITE_FOR_TESTS|standInDoor|DrawnDevices|StandInViewer|StandInWorker|refuseRealDevices/,
        "an address that starts at the origin's root": /\b(?:fetch|open|URL|WebSocket|EventSource|sendBeacon)\(\s*['"`]\/(?!\/)/,
        'a way to store outside its own database': /\b(localStorage|sessionStorage|document\.cookie)\b/,
        // No Talk in the first version: the page has nothing that could play what a viewer sends.
        'something that could play a sound': /\bel\(\s*['"`]audio['"`]|createElement\(\s*['"`]audio['"`]|\bAudioContext\b|\bnew\s+Audio\b|\.ontrack\b|addEventListener\(\s*['"`]track['"`]/,
    };
    for (const [what, pattern] of Object.entries(forbidden)) if (pattern.test(script)) problems.push(`the script has ${what}`);
    // The only addresses in it: the Worker's, its own origin's, and the names of standards (a header extension's, SVG's).
    const allowed = [api.origin, config.PAGE_ORIGIN, 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', 'http://www.w3.org/2000/svg'];
    for (const [address] of script.matchAll(/\b(?:https?|wss?):\/\/[^\s'"`)]+/g)) if (!allowed.some((ok) => address.startsWith(ok))) problems.push(`the script names an address it has no business with: ${address}`);
    const reaches = (script.match(/navigator\.mediaDevices/g) ?? []).length;
    if (reaches !== 1) problems.push(`the script reaches for the browser's cameras in ${reaches} places: it does in one, its entry`);
    if (!whole.endsWith("__require('main.js').start();\n})();\n")) problems.push("the script doesn't end by starting the page, once");

    // ---- The release document, and the list in it ----
    let document = null;
    try {
        document = JSON.parse(text('release.json'));
    } catch {
        problems.push("release.json isn't JSON");
    }
    if ((files.get('release.json')?.length ?? 0) > RELEASE_LIMITS.documentBytes) problems.push('release.json is past 65,536 bytes');
    if (document && (document.v !== 1 || typeof document.list !== 'string' || !Array.isArray(document.signatures))) {
        problems.push("release.json isn't a release document");
        document = null;
    }
    if (document) {
        if (document.signatures.length !== 0) problems.push('release.json claims a signature this build never makes');
        const wrong = problemsWithList(document.list);
        problems.push(...wrong.map((problem) => `release.json's list: ${problem}`));
        if (wrong.length === 0) {
            const list = JSON.parse(document.list);
            if (list.page !== config.PAGE) problems.push("release.json's list is for another page than src/config.js names");
            if (list.release !== config.RELEASE) problems.push("release.json's list has another release number than src/config.js");
            if (list.entry !== 'index.html') problems.push("release.json's entry isn't index.html");
            const listed = new Map(list.files.map((file) => [file.path, file]));
            for (const [name, bytes] of files) {
                if (name === 'release.json') continue;
                const entry = listed.get(name);
                if (!entry) problems.push(`release.json leaves out ${name}`);
                else if (entry.bytes !== bytes.length || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) problems.push(`release.json has the wrong length or hash for ${name}`);
            }
            for (const name of listed.keys()) if (!files.has(name)) problems.push(`release.json lists ${name}, which isn't in the build`);
            if (JSON.stringify(list.files.map((file) => file.path)) !== JSON.stringify([...listed.keys()].sort())) problems.push("release.json's files aren't in order");
        }
    }
    for (const [name, bytes] of files) if (bytes.includes(13)) problems.push(`${name} has a carriage return in it`);
    // As a viewer's app would check it before showing a code. Unsigned, a
    // build is turned away for that and for nothing else; signed, it would
    // be taken, and its files are what its address would have to serve.
    if (problems.length === 0) problems.push(...(await problemsForAViewer(folder, config)));
    return problems;
}

/**
 * What a viewer's app would say of a build (docs/API.md, The camera page,
 * What the app does), as a list of plain sentences: empty when the build
 * as it stands is turned away only for being unsigned, and the same list
 * signed is taken for the page src/config.js names, with every file the
 * address would serve the one the list gives. The key that signs here is
 * made for this check, can't be read out, and is kept nowhere.
 * @param {string} folder @param {{ PAGE: string, RELEASE: number }} config @returns {Promise<string[]>}
 */
export async function problemsForAViewer(folder, config) {
    const problems = [];
    const files = filesIn(folder);
    const served = files.get('release.json') ?? Buffer.alloc(0);
    const key = await makeCheckKey();
    const build = { keys: [Buffer.from(key.publicKey).toString('base64url')], page: config.PAGE, minimum: config.RELEASE };
    const said = async (document, how = build) => {
        try {
            return { taken: await checkRelease(document, how) };
        } catch (error) {
            if (error instanceof ReleaseError) return { code: error.code };
            throw error;
        }
    };
    const unsigned = await said(served);
    if (unsigned.code !== 'not_signed') problems.push(`a viewer would say "${unsigned.code ?? 'taken'}" of release.json as built, not "not_signed"`);
    const list = JSON.parse(served.toString('utf8')).list;
    const signed = await said(releaseDocument(list, [await signRelease(list, key)]));
    if (!signed.taken) {
        problems.push(`signed, a viewer would still turn the release away: ${signed.code}`);
        return problems;
    }
    // The same release, read by a build that carries another address, isn't taken: a release is for one page.
    const elsewhere = await said(releaseDocument(list, [await signRelease(list, key)]), { ...build, page: `${config.PAGE}elsewhere/` });
    if (elsewhere.code !== 'another_page') problems.push('signed, a build for another address would take this release');
    try {
        await checkServed(signed.taken, { address: files.get(signed.taken.entry) ?? null, files: Object.fromEntries(files) });
    } catch (error) {
        if (!(error instanceof ReleaseError)) throw error;
        problems.push(`what the build's folder would serve isn't what its list gives: ${error.message}`);
    }
    return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const twice = await buildsTheSameTwice();
    console.log(twice.same ? 'Built twice, apart: the same bytes.' : `Built twice, and these differ: ${twice.differing.join(', ')}`);
    for (const file of twice.files) console.log(`  ${file.name}  ${file.bytes} bytes  sha256 ${file.sha256}`);
    const folder = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-build-'));
    try {
        await build(folder);
        const problems = await problemsIn(folder);
        console.log(problems.length === 0 ? "It keeps the page's rules." : `It breaks the page's rules:\n${problems.map((p) => `  ${p}`).join('\n')}`);
        const built = await build(folder);
        console.log(`Its list is release ${built.release}'s for ${built.page}, unsigned: a viewer turns it away for that alone, and takes the same list signed.`);
        process.exitCode = twice.same && problems.length === 0 ? 0 : 1;
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}
