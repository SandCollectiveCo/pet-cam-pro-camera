// A server for this Mac's loopback and nothing else: it hands a browser the
// pages in dev/ and the page's source as it is, unbuilt, and takes back what
// a test page reports. None of it is part of a release (tools/build.mjs
// reads src/ alone).
//
//   node dev/server.mjs [port]     then open http://127.0.0.1:<port>/dev/
//
// Every answer tells the browser to refuse the camera and the microphone to
// the page (Permissions-Policy), so nothing served from here can turn one
// on, whatever its code asks for: the pages here feed themselves a drawn
// picture and a made tone (dev/drawn.js).

import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateFor, newForwarder } from './forwarder.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.txt': 'text/plain; charset=utf-8',
};

/** What a page may be handed from this folder: source, tests, dev pages, the
 * vectors, and a build when there is one. */
const SERVED = ['src', 'test', 'dev', 'vectors', 'dist', '.tmp'];

const HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // No page from here may have this Mac's camera or microphone.
    'permissions-policy': 'camera=(), microphone=(), display-capture=(), geolocation=()',
    'feature-policy': "camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'",
};

/** @param {http.IncomingMessage} req @returns {Promise<Buffer>} */
async function bodyOf(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * @param {{ port?: number, quiet?: boolean }} [options] port 0 takes any free one
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, reports: (run: string) => any[], next: (run: string, kind: string, within?: number) => Promise<any>, tell: (run: string, message: unknown) => void }>}
 */
export function startDevServer(options = {}) {
    /** What each run's pages have reported, in order. @type {Map<string, any[]>} */
    const reported = new Map();
    /** @type {Map<string, (() => void)[]>} */
    const waiting = new Map();
    /** What a run's pages are told, which they collect by asking. @type {Map<string, unknown[]>} */
    const told = new Map();
    /** Forwarders a test page asked for, by id (dev/forwarder.mjs). @type {Map<string, Awaited<ReturnType<typeof newForwarder>>>} */
    const forwarders = new Map();
    const wake = (key) => {
        for (const resolve of waiting.get(key) ?? []) resolve();
        waiting.delete(key);
    };
    const sleepUntil = (key, ms) => new Promise((resolve) => {
        const list = waiting.get(key) ?? [];
        list.push(resolve);
        waiting.set(key, list);
        setTimeout(resolve, ms);
    });

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const send = (status, body, type = 'application/json; charset=utf-8') => {
            res.writeHead(status, { ...HEADERS, 'content-type': type });
            res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
        };
        try {
            // A test page says how it went.
            if (req.method === 'POST' && url.pathname === '/__report') {
                const run = url.searchParams.get('run') ?? '';
                const list = reported.get(run) ?? [];
                list.push(JSON.parse((await bodyOf(req)).toString('utf8')));
                reported.set(run, list);
                wake(`report:${run}`);
                return send(200, { ok: true });
            }
            // A page asks what it has been told since `after`, waiting a while for something.
            if (req.method === 'GET' && url.pathname === '/__told') {
                const run = url.searchParams.get('run') ?? '';
                const after = Number(url.searchParams.get('after') ?? 0);
                if ((told.get(run) ?? []).length <= after) await sleepUntil(`told:${run}`, 20_000);
                return send(200, (told.get(run) ?? []).slice(after));
            }
            // A page asks for a forwarder to put between its two ends, and later for what it read.
            if (req.method === 'POST' && url.pathname === '/__forwarder') {
                const forwarder = await newForwarder();
                const id = String(forwarders.size + 1);
                forwarders.set(id, forwarder);
                return send(200, { id, first: candidateFor(forwarder.address, forwarder.portA), second: candidateFor(forwarder.address, forwarder.portB) });
            }
            // A page has a forwarder reach its first end unasked, as a relay would (dev/forwarder.mjs).
            if (req.method === 'POST' && /^\/__forwarder\/\d+\/reach$/.test(url.pathname)) {
                const forwarder = forwarders.get(url.pathname.split('/')[2]);
                const ports = (url.searchParams.get('ports') ?? '').split(',').map(Number);
                return forwarder ? send(200, { reach: forwarder.reach(ports) }) : send(404, { error: 'not_found' });
            }
            if (req.method === 'GET' && url.pathname.startsWith('/__forwarder/')) {
                const forwarder = forwarders.get(url.pathname.slice('/__forwarder/'.length));
                return forwarder ? send(200, forwarder.report()) : send(404, { error: 'not_found' });
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method_not_allowed' });
            const wanted = decodeURIComponent(url.pathname);
            const relative = wanted.endsWith('/') ? `${wanted}index.html` : wanted;
            const file = path.normalize(path.join(root, relative));
            const top = path.relative(root, file).split(path.sep)[0];
            if (!file.startsWith(root + path.sep) || !SERVED.includes(top) || !existsSync(file) || !statSync(file).isFile()) return send(404, { error: 'not_found' });
            const type = TYPES[path.extname(file)];
            if (!type) return send(404, { error: 'not_found' });
            res.writeHead(200, { ...HEADERS, 'content-type': type });
            if (req.method === 'HEAD') return res.end();
            createReadStream(file).pipe(res);
        } catch (error) {
            send(500, { error: 'internal_error', message: String(error?.message ?? error) });
        }
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        // Loopback only: nothing off this Mac can reach it.
        server.listen(options.port ?? 0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            if (!options.quiet) console.log(`dev server on http://127.0.0.1:${port}/dev/`);
            resolve({
                url: `http://127.0.0.1:${port}`,
                port,
                close: () => new Promise((done) => {
                    for (const forwarder of forwarders.values()) forwarder.close();
                    server.closeAllConnections?.();
                    server.close(() => done());
                }),
                reports: (run) => reported.get(run) ?? [],
                /** The next report of `kind` from a run's page, or a throw after `within` ms. */
                next: async (run, kind, within = 60_000) => {
                    const start = Date.now();
                    for (;;) {
                        const found = (reported.get(run) ?? []).find((r) => r.kind === kind && !r.taken);
                        if (found) {
                            found.taken = true;
                            return found;
                        }
                        if (Date.now() - start > within) throw new Error(`no "${kind}" from run ${run} in ${within} ms`);
                        await sleepUntil(`report:${run}`, 500);
                    }
                },
                tell: (run, message) => {
                    const list = told.get(run) ?? [];
                    list.push(message);
                    told.set(run, list);
                    wake(`told:${run}`);
                },
            });
        });
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await startDevServer({ port: Number(process.argv[2] ?? 8790) });
}
