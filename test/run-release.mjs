// The built page, in a browser, under its own rules:
//
//   node test/run-release.mjs
//
// builds a release and opens it in a headless Chrome with a profile of its
// own. It checks that the page comes up from its three files and nothing
// else, at an origin's root as it is served and under a path all the same,
// that its Content-Security-Policy refuses what the page's rules
// forbid (inline script, eval, written HTML, a connection anywhere but the
// Worker), that a script changed by one byte isn't run, and that the page
// does nothing inside another page's frame.
//
// Chrome alone, on purpose: a release reaches for the browser's own camera
// once someone taps Start, and this page is opened with no link, so it is
// let in to nothing and never gets that far. In a headless Chrome with a
// fresh profile it couldn't be given one if it did. Nor does it reach the
// Worker: with no link and nothing kept, the page asks nothing of it, and
// a release's Worker is production's, which no test touches.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '../dev/server.mjs';
import { WORDS } from '../src/words.js';
import { build } from '../tools/build.mjs';
import { launchChrome } from '../tools/cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (ok, what) => {
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = "document.querySelector('#page').innerText.trim()";
/** A browser's complaints about a page, without the dev server's own header warning. */
const complaints = (page) => page.log.filter((entry) => (entry.kind === 'exception' || entry.kind.endsWith('.error')) && !entry.text.includes('Feature-Policy'));

const { files } = await build();
const tampered = path.join(root, '.tmp', 'tampered');
rmSync(tampered, { recursive: true, force: true });
mkdirSync(tampered, { recursive: true });
for (const file of files) copyFileSync(path.join(root, 'dist', file.path), path.join(tampered, file.path));
const script = files.find((file) => file.path.endsWith('.js')).path;
writeFileSync(path.join(tampered, script), readFileSync(path.join(tampered, script), 'utf8').replace("live: 'Live'", "live: 'Lyve'"));

/** The build served as its host will serve it: at an origin's root, the address itself answering with the entry file, and nothing but the build's own files. Loopback only. */
function serveAtRoot() {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    const names = new Set([...files.map((file) => file.path), 'release.json']);
    const host = http.createServer((req, res) => {
        const wanted = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        const name = wanted === '/' ? 'index.html' : wanted.slice(1);
        if (req.method !== 'GET' || !names.has(name)) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            return res.end('not found');
        }
        res.writeHead(200, { 'content-type': types[path.extname(name)], 'cache-control': 'no-store', 'permissions-policy': 'camera=(), microphone=(), display-capture=()' });
        res.end(readFileSync(path.join(root, 'dist', name)));
    });
    return new Promise((resolve) => host.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${host.address().port}/`, close: () => new Promise((done) => { host.closeAllConnections?.(); host.close(() => done()); }) })));
}

const server = await startDevServer({ quiet: true });
const atRoot = await serveAtRoot();
const chrome = await launchChrome();
try {
    console.log(`The built page in ${chrome.version}:`);
    // As it is served: at its origin's root, its address answering with the page itself. Opened as a camera invite's
    // link is, with its payload in the fragment: one for the address a release carries, which isn't this test's, so it is
    // no link to this page and nothing is asked of any Worker.
    const payload = Buffer.from(JSON.stringify({ v: 3, i: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', t: Buffer.alloc(32, 12).toString('base64url') })).toString('base64url');
    const rooted = await chrome.newPage(`${atRoot.url}#${payload}`, { viewport: { width: 390, height: 844, scale: 2, mobile: true } });
    for (let i = 0; i < 50 && (await rooted.evaluate(shown)) === ''; i++) await sleep(100);
    check((await rooted.evaluate(shown)) === WORDS.nothing, `at an origin's root it comes up, and says what a page opened with no code says: "${await rooted.evaluate(shown)}"`);
    const askedAtRoot = rooted.requests.filter((url) => url.startsWith('http')).map((url) => new URL(url).pathname.replace(/\.[0-9a-f]{16}\./, '.<hash>.')).sort();
    check(JSON.stringify(askedAtRoot) === JSON.stringify(['/', '/camera.<hash>.css', '/camera.<hash>.js']), `there it asks for its address and its two files by their names, and nothing else: ${askedAtRoot.join(', ')}`);
    const left = await rooted.evaluate('location.href');
    check(left === atRoot.url, `the fragment a link's token rides in is out of the address once it has started: ${left === atRoot.url ? left : 'still there'}`);
    check(!JSON.stringify(rooted.requests).includes(payload), 'and it went nowhere: no request carried it');
    check(complaints(rooted).length === 0, `the browser has no complaint about it there${complaints(rooted).map((entry) => `\n      [${entry.kind}] ${entry.text}`).join('')}`);
    await rooted.close();
    // Under a path, from the same files: nothing in it rests on where it is served.
    const page = await chrome.newPage(`${server.url}/dist/index.html`, { viewport: { width: 390, height: 844, scale: 2, mobile: true } });
    for (let i = 0; i < 50 && (await page.evaluate(shown)) === ''; i++) await sleep(100);
    check((await page.evaluate(shown)) === WORDS.nothing, `it comes up, and says what a page opened with no code says: "${await page.evaluate(shown)}"`);
    const asked = page.requests.filter((url) => url.startsWith('http')).map((url) => new URL(url).pathname.replace(/\.[0-9a-f]{16}\./, '.<hash>.')).sort();
    check(JSON.stringify(asked) === JSON.stringify(['/dist/camera.<hash>.css', '/dist/camera.<hash>.js', '/dist/index.html']), `it asks the network for its three files and nothing else: ${asked.join(', ')}`);
    check(complaints(page).length === 0, `the browser has no complaint about it${complaints(page).map((entry) => `\n      [${entry.kind}] ${entry.text}`).join('')}`);
    check((await page.evaluate('document.title')) === WORDS.title, 'its title is its own');

    // What its policy refuses, tried from inside the page.
    const before = page.log.length;
    // Refused twice over: a script's text can't even be set, and one put in the page some other way wouldn't run.
    check((await page.evaluate("(() => { try { const s = document.createElement('script'); s.textContent = 'window.petcamInlineRan = 1'; document.body.append(s); } catch (error) { return error.name; } return window.petcamInlineRan === undefined ? 'did not run' : 'ran'; })()")) !== 'ran', 'script written into the page does not run');
    check(await page.evaluate("(() => { const s = document.createElement('script'); s.setAttribute('src', 'data:text/javascript,window.petcamDataRan=1'); document.body.append(s); return new Promise((resolve) => setTimeout(() => resolve(window.petcamDataRan === undefined), 300)); })()").catch(() => true), 'nor does a script from anywhere but the page’s own files');
    // Asked of the page's own code, through a timer: what a debugger evaluates itself isn't held to the page's policy.
    const evaluated = await page.evaluate("new Promise((resolve) => setTimeout(() => { try { resolve('ran: ' + window.eval('1 + 1')); } catch (error) { resolve(error.name); } }, 0))");
    check(evaluated === 'EvalError' || evaluated === 'TypeError', `eval is refused (${evaluated})`);
    const made = await page.evaluate("new Promise((resolve) => setTimeout(() => { try { resolve('ran: ' + new Function('return 2')()); } catch (error) { resolve(error.name); } }, 0))");
    check(made === 'EvalError' || made === 'TypeError', `and so is making a function from text (${made})`);
    check((await page.evaluate("(() => { try { document.body.insertAdjacentHTML('beforeend', '<b>x</b>'); return 'written'; } catch (error) { return error.name; } })()")) === 'TypeError', 'HTML written from text is refused');
    check((await page.evaluate("fetch('http://127.0.0.1:9/').then(() => 'fetched', (error) => error.name)")) === 'TypeError', 'a fetch to anywhere but the Worker is refused');
    check((await page.evaluate("new Promise((resolve) => { const socket = new WebSocket('ws://127.0.0.1:9/'); socket.onerror = () => resolve('refused'); socket.onopen = () => resolve('open'); })")) === 'refused', 'a socket to anywhere but the Worker is refused');
    check((await page.evaluate("(() => { const d = document.createElement('div'); d.setAttribute('style', 'color: rgb(1, 2, 3)'); document.body.append(d); return getComputedStyle(d).color; })()")) !== 'rgb(1, 2, 3)', 'a style written into an element is refused');
    await sleep(200);
    const refusals = page.log.slice(before).filter((entry) => /Content Security Policy|TrustedHTML|Trusted Type/i.test(entry.text));
    check(refusals.length >= 5, `and each refusal was the policy's own (${refusals.length} of them logged)`);
    check((await page.evaluate("typeof navigator.serviceWorker === 'undefined' ? 0 : navigator.serviceWorker.getRegistrations().then((all) => all.length)")) === 0, 'no service worker');
    await page.close();

    const broken = await chrome.newPage(`${server.url}/.tmp/tampered/index.html`);
    await sleep(1_500);
    check((await broken.evaluate(shown)) === '', 'a script changed by one byte is not run: the page stays empty');
    check(broken.log.some((entry) => /integrity/i.test(entry.text)), "and the browser says why: its hash isn't the one the page names");
    await broken.close();

    const framed = await chrome.newPage(`${server.url}/dev/frame.html`);
    const inFrame = "document.querySelector('iframe').contentDocument.querySelector('#page').innerText.trim()";
    for (let i = 0; i < 50 && (await framed.evaluate(inFrame).catch(() => '')) === ''; i++) await sleep(100);
    check((await framed.evaluate(inFrame)) === WORDS.unsupported, "inside another page's frame it does nothing but say it can't be a camera there");
    await framed.close();
} finally {
    await chrome.close();
    await server.close();
    await atRoot.close();
    rmSync(tampered, { recursive: true, force: true });
}
console.log(failures.length === 0 ? '\nThe built page keeps its rules in a browser.' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
