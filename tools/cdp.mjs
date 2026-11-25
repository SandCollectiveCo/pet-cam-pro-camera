// Chrome driven from Node with nothing installed: its DevTools protocol over
// Node's own WebSocket. Enough to open a page in a headless Chrome with a
// profile of its own, read what the page logs and what the browser refuses
// (a Content-Security-Policy violation is a log entry), run an expression
// in it, and take its picture.
//
// The Chrome it starts never touches the person's own Chrome or its
// profile, makes no sound, and is given no camera and no microphone: there
// is no flag here that would answer a permission prompt for a page.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
];

/** Where Chrome is on this computer, or null. */
export const chromePath = () => CANDIDATES.find((candidate) => candidate && existsSync(candidate)) ?? null;

/**
 * @param {{ headless?: boolean, args?: string[], windowSize?: [number, number] }} [options]
 */
export async function launchChrome(options = {}) {
    const binary = chromePath();
    if (!binary) throw new Error('No Chrome found: set CHROME_PATH');
    const profile = mkdtempSync(path.join(os.tmpdir(), 'petcam-web-camera-chrome-'));
    const [width, height] = options.windowSize ?? [1280, 800];
    const child = spawn(binary, [
        ...(options.headless === false ? [] : ['--headless=new']),
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        `--window-size=${width},${height}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--metrics-recording-only',
        '--password-store=basic',
        '--use-mock-keychain',
        // Nothing a test page plays reaches this computer's speakers.
        '--mute-audio',
        // A made tone starts without a tap, as a real page's would after Start.
        '--autoplay-policy=no-user-gesture-required',
        ...(options.args ?? []),
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const endpoint = await new Promise((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error(`Chrome didn't say where its DevTools are:\n${seen}`)), 20_000);
        child.stderr.on('data', (chunk) => {
            seen += chunk;
            const found = seen.match(/DevTools listening on (ws:\/\/\S+)/);
            if (found) {
                clearTimeout(timer);
                resolve(found[1]);
            }
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Chrome exited (${code}) before it started:\n${seen}`));
        });
    });

    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error('no connection to Chrome'));
    });
    let nextId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    const pending = new Map();
    /** @type {Map<string, (method: string, params: any) => void>} */
    const listeners = new Map();
    socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data));
        if (message.id !== undefined) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) waiter?.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`));
            else waiter?.resolve(message.result);
        } else if (message.sessionId) listeners.get(message.sessionId)?.(message.method, message.params);
    };
    /** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const version = await send('Browser.getVersion');
    let closed = false;

    return {
        /** "Chrome/158.0.8127.89", as the browser says it. */
        version: version.product,
        /**
         * @param {string} url
         * @param {{ viewport?: { width: number, height: number, scale?: number, mobile?: boolean } }} [how]
         */
        async newPage(url, how = {}) {
            const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
            const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
            /** What the page logged, and what the browser logged about it. @type {{ kind: string, text: string }[]} */
            const log = [];
            /** Every address the page asked the network for. @type {string[]} */
            const requests = [];
            const waiters = new Set();
            listeners.set(sessionId, (method, params) => {
                if (method === 'Runtime.consoleAPICalled') log.push({ kind: `console.${params.type}`, text: params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview ?? '')).join(' ') });
                else if (method === 'Runtime.exceptionThrown') log.push({ kind: 'exception', text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text });
                else if (method === 'Log.entryAdded') log.push({ kind: `browser.${params.entry.source}.${params.entry.level}`, text: `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}` });
                else if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
                for (const waiter of waiters) waiter(method, params);
            });
            const call = (method, params) => send(method, params, sessionId);
            await call('Runtime.enable');
            await call('Log.enable');
            await call('Page.enable');
            await call('Network.enable');
            if (how.viewport) {
                await call('Emulation.setDeviceMetricsOverride', {
                    width: how.viewport.width, height: how.viewport.height, deviceScaleFactor: how.viewport.scale ?? 1, mobile: how.viewport.mobile ?? false,
                });
            }
            const loaded = new Promise((resolve) => {
                const waiter = (method) => {
                    if (method === 'Page.loadEventFired') {
                        waiters.delete(waiter);
                        resolve(undefined);
                    }
                };
                waiters.add(waiter);
            });
            await call('Page.navigate', { url });
            await loaded;
            return {
                log,
                requests,
                call,
                /** The value of an expression in the page; a promise is waited for.
                 * @param {string} expression @returns {Promise<any>} */
                async evaluate(expression) {
                    const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
                    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
                    return result.value;
                },
                /** A PNG of the page as it shows. @returns {Promise<Buffer>} */
                async screenshot() {
                    const { data } = await call('Page.captureScreenshot', { format: 'png' });
                    return Buffer.from(data, 'base64');
                },
                async close() {
                    listeners.delete(sessionId);
                    await send('Target.closeTarget', { targetId }).catch(() => {});
                },
            };
        },
        async close() {
            if (closed) return;
            closed = true;
            await send('Browser.close').catch(() => {});
            socket.close();
            await new Promise((resolve) => {
                if (child.exitCode !== null) return resolve(undefined);
                child.on('exit', resolve);
                setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve(undefined);
                }, 5_000);
            });
            rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}
