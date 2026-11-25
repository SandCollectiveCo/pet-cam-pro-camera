// Runs the tests in Node: `node test/run-node.mjs [part of a test's name]`.
// Node's Web Crypto is the same interface the page uses in a browser, so
// this holds the page's code to the vectors; test/run-browsers.mjs then
// holds each browser's own crypto to them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { differing } from '../tools/sync-vectors.mjs';
import { runAll } from './lib/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.petcamTestVectors = async (name) => JSON.parse(readFileSync(path.join(here, '..', 'vectors', `${name}.json`), 'utf8'));

await import('./all.js');
await import('./node-only.js');
await import('./publishing.node.js');

const changed = differing();
if (changed === null) console.log("· docs/vectors/ isn't beside this folder: the copies in vectors/ weren't compared with it");
else if (changed.length > 0) {
    console.error(`✗ these copies differ from docs/vectors/: ${changed.join(', ')} (node tools/sync-vectors.mjs)`);
    process.exitCode = 1;
} else console.log("✓ the copies in vectors/ are docs/vectors/'s, byte for byte");

const results = await runAll({
    filter: process.argv[2],
    each: (r) => console.log(r.skipped ? `· ${r.name} (a browser's)` : r.ok ? `✓ ${r.name} (${r.ms} ms)` : `✗ ${r.name}\n    ${r.error.split('\n').join('\n    ')}`),
});
const failed = results.filter((r) => !r.ok);
const ran = results.filter((r) => !r.skipped);
console.log(`\n${ran.length - failed.length} of ${ran.length} passed in Node ${process.version}${failed.length ? `, ${failed.length} FAILED` : ''}`);
if (failed.length > 0) process.exitCode = 1;
