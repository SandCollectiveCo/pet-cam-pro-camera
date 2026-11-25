// Takes a picture of the page's screen in each of its states (dev/screens.js),
// in a headless Chrome at a phone's size, and lays them out on one sheet:
//
//   node tools/shots.mjs [folder]        .tmp/shots by default
//
// The facts in them are made up and the picture is a drawn one. They're for
// looking at the words and the layout, nothing else.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '../dev/server.mjs';
import { launchChrome } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, '.tmp', 'shots'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const PHONE = { width: 390, height: 844, scale: 2, mobile: true };
const WIDE = { width: 1180, height: 760, scale: 1, mobile: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await startDevServer({ quiet: true });
const chrome = await launchChrome();
try {
    const list = await chrome.newPage(`${server.url}/dev/screens.html`, { viewport: PHONE });
    let states = [];
    for (let i = 0; i < 50 && states.length === 0; i++) {
        states = ((await list.evaluate('document.body.dataset.states')) ?? '').split(',').filter(Boolean);
        await sleep(100);
    }
    await list.close();
    const taken = [];
    for (const name of states) {
        // A computer's states at a computer's size, the rest at a phone's.
        const viewport = name.endsWith('-mac') || name === 'headset' ? WIDE : PHONE;
        const page = await chrome.newPage(`${server.url}/dev/screens.html?show=${name}`, { viewport });
        for (let i = 0; i < 50 && (await page.evaluate('document.body.dataset.shown')) !== name; i++) await sleep(100);
        // A moment for the drawn picture's first frame.
        await sleep(350);
        const file = `${name}.png`;
        writeFileSync(path.join(out, file), await page.screenshot());
        const complaints = page.log.filter((entry) => entry.kind === 'exception' || (entry.kind.endsWith('.error') && !entry.text.includes('Feature-Policy')));
        if (complaints.length > 0) console.log(`  ${name}: ${complaints.map((entry) => entry.text).join('; ')}`);
        taken.push({ name, file, wide: viewport === WIDE });
        await page.close();
    }
    // One sheet of them all.
    const sheet = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The camera page's screen, state by state</title><style>
body { margin: 0; padding: 28px; background: #2a2a2e; color: #eee; font: 15px/1.3 -apple-system, system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 6px; } p { margin: 0 0 22px; color: #bbb; }
.grid { display: flex; flex-wrap: wrap; gap: 26px 22px; align-items: flex-end; }
figure { margin: 0; } figcaption { margin-top: 8px; color: #ddd; font-weight: 600; }
img { display: block; width: 234px; border-radius: 22px; border: 1px solid #555; } img.wide { width: 560px; border-radius: 10px; }
</style></head><body><h1>The camera page's screen, state by state</h1><p>Made-up facts and a drawn picture, for looking at the words and the layout. Every word is picked (web-camera/WORDS.md).</p><div class="grid">${taken.map((shot) => `<figure><img src="${shot.file}" alt="${shot.name}"${shot.wide ? ' class="wide"' : ''}><figcaption>${shot.name}</figcaption></figure>`).join('')}</div></body></html>`;
    writeFileSync(path.join(out, 'index.html'), sheet);
    const relative = path.relative(root, out).split(path.sep).join('/');
    const whole = await chrome.newPage(`${server.url}/${relative}/index.html`, { viewport: { width: 1620, height: 900 } });
    await sleep(600);
    const height = await whole.evaluate('document.documentElement.scrollHeight');
    await whole.call('Emulation.setDeviceMetricsOverride', { width: 1620, height, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    writeFileSync(path.join(out, 'sheet.png'), await whole.screenshot());
    await whole.close();
    console.log(`${taken.length} states pictured in ${path.relative(process.cwd(), out)}, and all of them on sheet.png`);
} finally {
    await chrome.close();
    await server.close();
}
