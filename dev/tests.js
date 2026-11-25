// Runs the page's tests in this browser and reports them to the dev server
// (test/run-browsers.mjs reads them there). `?run=<id>` names the run,
// `?filter=<text>` picks tests, and `?close=1` has the tab close itself when
// it's done, which a browser allows a tab that has shown nothing else.

import { runAll } from '../test/lib/harness.js';
import { realDevicesAreRefused, refuseRealDevices } from './guard.js';

refuseRealDevices();
if (!realDevicesAreRefused()) throw new Error("This page couldn't put its refusal of real cameras in place, so it runs nothing.");

const query = new URLSearchParams(location.search);
const run = query.get('run') ?? 'by-hand';
const log = document.getElementById('log');
const summary = document.getElementById('summary');

const report = (body) => fetch(`/__report?run=${encodeURIComponent(run)}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});

globalThis.petcamTestVectors = async (name) => {
    const answer = await fetch(`/vectors/${name}.json`);
    if (!answer.ok) throw new Error(`no vectors/${name}.json`);
    return answer.json();
};

const line = (text, cls) => {
    const row = document.createElement('div');
    row.textContent = text;
    if (cls) row.className = cls;
    log.append(row);
};

try {
    await import('../test/all.js');
    await import('../test/browser-only.js');
    const results = await runAll({
        filter: query.get('filter') ?? undefined,
        each: (r) => line(r.skipped ? `· ${r.name} (Node's)` : r.ok ? `✓ ${r.name} (${r.ms} ms)` : `✗ ${r.name}\n${r.error}`, r.ok ? 'ok' : 'bad'),
    });
    const ran = results.filter((r) => !r.skipped);
    const failed = ran.filter((r) => !r.ok);
    summary.textContent = `${ran.length - failed.length} of ${ran.length} passed${failed.length ? `, ${failed.length} failed` : ''}.`;
    summary.className = failed.length ? 'bad' : 'ok';
    await report({ kind: 'done', agent: navigator.userAgent, results });
} catch (error) {
    summary.textContent = `The tests didn't run: ${error?.message ?? error}`;
    summary.className = 'bad';
    await report({ kind: 'done', agent: navigator.userAgent, results: [{ name: 'the tests load', ok: false, ms: 0, error: `${error?.name}: ${error?.message}\n${error?.stack ?? ''}` }] });
}

if (query.get('close') === '1') {
    line('This tab closes itself now. If it is still here, it can be closed.');
    window.close();
    // Still running a second later means the browser didn't let it close.
    setTimeout(() => report({ kind: 'still-open' }), 1_000);
}
