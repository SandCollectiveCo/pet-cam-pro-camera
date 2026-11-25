// Runs the tests in the browsers on this computer:
//
//   node test/run-browsers.mjs [chrome] [safari] [--filter <text>]
//
// Chrome runs headless with a profile of its own, driven over its DevTools
// protocol (tools/cdp.mjs). Safari has no such door unless its owner opens
// one (Settings › Developer › Allow remote automation), so it is asked to
// open one tab, in the background, which runs the tests and closes itself.
// That tab is in the person's own Safari: if Safari wasn't running, this
// starts it, and it is left running.
//
// Neither is given a camera or a microphone. The dev server tells each
// browser to refuse both to its pages, and the pages feed themselves a
// drawn picture and a made tone.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { startDevServer } from '../dev/server.mjs';
import { chromePath, launchChrome } from '../tools/cdp.mjs';

const args = process.argv.slice(2);
const filterAt = args.indexOf('--filter');
const filter = filterAt >= 0 ? args[filterAt + 1] : null;
const named = args.filter((arg, i) => !arg.startsWith('--') && (filterAt < 0 || i !== filterAt + 1));
const wanted = named.length > 0 ? named : ['chrome', 'safari'];
const TIMEOUT = 180_000;

const server = await startDevServer({ quiet: true });
const pageUrl = (run, more = '') => `${server.url}/dev/tests.html?run=${run}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}${more}`;
let failedAnywhere = false;

/** @param {string} browser @param {{ agent: string, results: any[] }} report */
function print(browser, report) {
    const ran = report.results.filter((r) => !r.skipped);
    const failed = ran.filter((r) => !r.ok);
    for (const r of report.results) {
        console.log(r.skipped ? `  · ${r.name} (Node's)` : r.ok ? `  ✓ ${r.name} (${r.ms} ms)` : `  ✗ ${r.name}\n      ${String(r.error).split('\n').join('\n      ')}`);
        for (const text of r.notes ?? []) console.log(`      · ${text}`);
    }
    console.log(`${ran.length - failed.length} of ${ran.length} passed in ${browser}${failed.length ? `, ${failed.length} FAILED` : ''}\n  ${report.agent}\n`);
    if (failed.length > 0 || ran.length === 0) failedAnywhere = true;
}

try {
    if (wanted.includes('chrome')) {
        if (!chromePath()) {
            console.log('Chrome: not on this computer (set CHROME_PATH)\n');
            failedAnywhere = true;
        } else {
            const chrome = await launchChrome();
            try {
                console.log(`${chrome.version}, headless:`);
                const page = await chrome.newPage(pageUrl('chrome'));
                const report = await server.next('chrome', 'done', TIMEOUT).catch((error) => {
                    console.log(page.log.map((entry) => `  [${entry.kind}] ${entry.text}`).join('\n'));
                    throw error;
                });
                print(chrome.version, report);
                const complaints = page.log.filter((entry) => entry.kind === 'exception' || entry.kind.endsWith('.error'));
                if (complaints.length > 0) console.log(`  what the page logged:\n${complaints.map((entry) => `    [${entry.kind}] ${entry.text}`).join('\n')}\n`);
            } finally {
                await chrome.close();
            }
        }
    }
    if (wanted.includes('safari')) {
        if (!existsSync('/Applications/Safari.app')) console.log('Safari: not on this computer\n');
        else {
            console.log('Safari, one background tab that closes itself:');
            await promisify(execFile)('/usr/bin/open', ['-g', '-a', 'Safari', pageUrl('safari', '&close=1')]);
            const report = await server.next('safari', 'done', TIMEOUT);
            print('Safari', report);
            // The tab says so if it is still there a moment after it closed itself.
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            const left = server.reports('safari').some((r) => r.kind === 'still-open');
            console.log(left ? "  The tab didn't close itself: it is still open in Safari, and can be closed by hand.\n" : '  The tab closed itself.\n');
        }
    }
} finally {
    // A moment for the Safari tab to close before the server it came from goes.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await server.close();
}
process.exitCode = failedAnywhere ? 1 : 0;
