// The page's dev build, served as a release is, so that a Debug build of
// the app on this Mac's Worker starts a temporary camera on it: the page's
// own source on the real door (dev/live.js, a drawn picture and a made
// tone), at an address of its own ending in a slash, with every file it
// loads listed in a release document signed by a key made for the run and
// kept nowhere. The app takes that page and that key at launch
// (`-cameraPage`, `-cameraPageKeys`, in a Debug build whose Worker is this
// Mac's) and holds the page to every rule it holds the real one to.
//
//   node dev/release.mjs --worker <port> [--port 8790] [--out <folder>] [--release 1]
//
// It serves http://127.0.0.1:<port>/ on loopback and nothing else: the entry
// at the address itself, every file the dev build loads under it, and
// release.json. The page talks to the Worker at http://127.0.0.1:<worker
// port> alone, whose CAMERA_PAGE_ORIGIN has to be http://127.0.0.1:<port>.
// It writes <out>/page.txt (the address), <out>/page-key.txt (the key the app
// is launched with) and <out>/shows.jsonl (what the page shows, as it
// changes), and prints the app's launch arguments. A page opened at a link
// whose fragment is a camera invite asks with it; with none, it asks nothing.
//
// Never part of a release: nothing in src/ reaches this, and tools/build.mjs
// reads src/ alone.

import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCheckKey, releaseDocument, releaseListText, signRelease } from '../tools/release.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'index.html';
const STATIC_IMPORT = /^import\s*(?:\{[\s\S]*?\}\s*from\s*)?'([^']+)';/gm;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // No page from here may have this Mac's camera or microphone: it draws its own.
    'permissions-policy': 'camera=(), microphone=(), display-capture=(), geolocation=()',
};

/** Every module `start` loads, itself included, as paths from the folder's root. @param {string} start */
function modulesFrom(start) {
    const found = new Set();
    const visit = (file) => {
        if (found.has(file)) return;
        found.add(file);
        for (const [, from] of readFileSync(path.join(root, file), 'utf8').matchAll(STATIC_IMPORT)) {
            if (!from.startsWith('.')) throw new Error(`${file} imports ${from}, which isn't one of this folder's files`);
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), from));
            if (target.startsWith('..')) throw new Error(`${file} imports ${from}, outside this folder`);
            visit(target);
        }
    };
    visit(start);
    return [...found].sort();
}

/** The dev build's entry: the page's own stylesheet, the dev pages' one, and dev/live.js, told which Worker. @param {number} worker */
const entryFor = (worker) => [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="petcam-worker" content="${worker}">`,
    '<title>Pet Cam Pro camera</title>',
    '<link rel="icon" href="data:,">',
    '<link rel="stylesheet" href="src/style.css">',
    '<link rel="stylesheet" href="dev/screens.css">',
    '</head>',
    '<body>',
    '<main id="page"></main>',
    '<script type="module" src="dev/live.js"></script>',
    '</body>',
    '</html>',
    '',
].join('\n');

/**
 * Serves the dev build as a release, signed for this run.
 * @param {{ worker: number, port?: number, release?: number, out?: string | null, quiet?: boolean }} how
 * @returns {Promise<{ page: string, key: string, document: string, files: Map<string, Buffer>, reports: () => any[], close: () => Promise<void> }>}
 */
export async function startDevRelease(how) {
    const port = how.port ?? 8790;
    if (!Number.isInteger(how.worker) || how.worker < 1 || how.worker > 65_535) throw new Error('Name the local Worker: --worker <port>, on 127.0.0.1');
    const page = `http://127.0.0.1:${port}/`;
    /** What it serves, read once, so what's served is what was signed. */
    const files = new Map([[ENTRY, Buffer.from(entryFor(how.worker))]]);
    for (const file of [...modulesFrom('dev/live.js'), 'src/style.css', 'dev/screens.css']) files.set(file, readFileSync(path.join(root, file)));
    const list = releaseListText({
        page, release: how.release ?? 1, entry: ENTRY,
        files: [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, bytes]) => ({ path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })),
    });
    const key = await makeCheckKey();
    const signature = await signRelease(list, key);
    const document = releaseDocument(list, [signature]);
    const reports = [];
    if (how.out) {
        mkdirSync(how.out, { recursive: true });
        writeFileSync(path.join(how.out, 'page.txt'), page);
        writeFileSync(path.join(how.out, 'page-key.txt'), signature.key);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', page);
        try {
            // What the page says it shows, as it changes.
            if (req.method === 'POST' && url.pathname === '/__report') {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                reports.push(report);
                if (how.out) appendFileSync(path.join(how.out, 'shows.jsonl'), `${JSON.stringify(report)}\n`);
                res.writeHead(200, { ...HEADERS, 'content-type': TYPES['.json'] });
                return res.end('{"ok":true}');
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, HEADERS);
                return res.end();
            }
            const name = url.pathname === '/' ? ENTRY : decodeURIComponent(url.pathname.slice(1));
            const body = name === 'release.json' ? Buffer.from(document) : files.get(name);
            if (!body) {
                res.writeHead(404, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' });
                return res.end('not found');
            }
            res.writeHead(200, { ...HEADERS, 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream' });
            return res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
            res.writeHead(500, HEADERS);
            return res.end();
        }
    });
    await new Promise((resolve, reject) => {
        server.on('error', reject);
        // Loopback only: nothing off this Mac can reach it.
        server.listen(port, '127.0.0.1', () => resolve(undefined));
    });
    if (!how.quiet) {
        console.log(`The page's dev build, as a release signed for this run, at ${page} (${files.size} files), talking to the Worker at http://127.0.0.1:${how.worker}.`);
        console.log(`Launch the app (a Debug build on that Worker) with: -PetCamAPIBaseURL http://127.0.0.1:${how.worker} -cameraPage ${page} -cameraPageKeys ${signature.key}`);
        if (how.out) console.log(`Written: ${path.join(how.out, 'page.txt')}, ${path.join(how.out, 'page-key.txt')}; what the page shows goes to ${path.join(how.out, 'shows.jsonl')}.`);
    }
    return {
        page, key: signature.key, document, files, reports: () => reports,
        close: () => new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
        }),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
        const at = args.indexOf(`--${name}`);
        return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
    };
    const out = option('out', null);
    await startDevRelease({ worker: Number(option('worker', '')), port: Number(option('port', '8790')), release: Number(option('release', '1')), out: out ? path.resolve(out) : null });
}
