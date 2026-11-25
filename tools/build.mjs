// Builds a release of the page: `node tools/build.mjs [folder]` (dist/ by
// default). Nothing is installed to do it and nothing is fetched: this file,
// Node's own modules, and src/.
//
// What comes out, and why it looks as it does (docs/WEB-CAMERA.md § 2, The
// page's rules):
//
//   index.html             the page: no inline script, its
//                          Content-Security-Policy written into it, and
//                          every file it loads named with that file's hash
//   camera.<hash>.js       all of the page's code, in one file, so one
//                          integrity attribute covers every line that runs
//                          (a browser checks nothing a module imports)
//   camera.<hash>.css      its one stylesheet
//   release.json           the release document: the list of those files
//                          with their lengths and hashes, as text, and its
//                          signatures (tools/release.mjs has the format).
//                          The list is what a release's signature is made
//                          over and what a viewer's app compares a served
//                          page with before it shows a code. A build signs
//                          nothing: its document has no signatures.
//
// The script is the source files as they are written, each wrapped in a
// function, with only its `import` and `export` words taken off: no
// minifier, no transpiler, nothing whose output has to be trusted. Anyone
// can lay camera.<hash>.js beside src/ and see they're the same.
//
// The same commit gives the same bytes: no time, no machine's name and no
// path goes in, files are taken in a fixed order, and every line end is \n.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE_LIMITS, isPageAddress, releaseDocument, releaseListText } from './release.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

/** @param {Buffer | string} data @param {string} algorithm @param {'hex' | 'base64'} encoding */
const hash = (data, algorithm, encoding) => createHash(algorithm).update(data).digest(encoding);

/** Every .js file under src/, as paths from src/ with forward slashes, in a fixed order. */
function sources(folder = '') {
    const out = [];
    for (const name of readdirSync(path.join(src, folder)).sort()) {
        const relative = folder ? `${folder}/${name}` : name;
        if (statSync(path.join(src, relative)).isDirectory()) out.push(...sources(relative));
        else if (name.endsWith('.js')) out.push(relative);
    }
    return out;
}

const IMPORT = /^import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';[ \t]*$/gm;
const EXPORT = /^export\s+((?:async\s+)?function\*?|class|const)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * One source file as a module of the bundle: its imports turned into reads
 * of other modules, its `export` words taken off, and what it exports
 * handed out at its end. Only the forms the page's code uses are taken, and
 * anything else stops the build: the result is checked against what the
 * file really exports.
 * @param {string} file a path from src/ @param {string} text
 */
function moduleOf(file, text) {
    if (text.includes('\r')) throw new Error(`${file}: line ends are \\n`);
    const imports = [];
    let body = text.replace(IMPORT, (_all, names, from) => {
        if (!from.startsWith('.')) throw new Error(`${file}: imports ${from}, which isn't one of the page's own files`);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), from));
        if (target.startsWith('..')) throw new Error(`${file}: imports ${from}, outside src/`);
        imports.push(target);
        const picked = names.split(',').map((name) => name.trim()).filter(Boolean).map((name) => name.replace(/\s+as\s+/, ': '));
        return `const { ${picked.join(', ')} } = __require('${target}');`;
    });
    const exported = [];
    body = body.replace(EXPORT, (_all, kind, name) => {
        exported.push(name);
        return `${kind} ${name}`;
    });
    const left = body.split('\n').find((line) => /^(import|export)\b/.test(line));
    if (left) throw new Error(`${file}: a form of import or export the build doesn't take: ${left}`);
    return { file, imports, exported, body };
}

/** Modules that import each other can't be laid out one after another: none of the page's do. */
function refuseCycles(modules) {
    const byFile = new Map(modules.map((module) => [module.file, module]));
    const state = new Map();
    const visit = (file, trail) => {
        if (state.get(file) === 'done') return;
        if (state.get(file) === 'visiting') throw new Error(`modules import each other: ${[...trail, file].join(' → ')}`);
        const module = byFile.get(file);
        if (!module) throw new Error(`${trail.at(-1)} imports ${file}, which isn't in src/`);
        state.set(file, 'visiting');
        for (const next of module.imports) visit(next, [...trail, file]);
        state.set(file, 'done');
    };
    for (const module of modules) visit(module.file, []);
}

/** The files `entry` needs, itself included. */
function reachable(modules, entry) {
    const byFile = new Map(modules.map((module) => [module.file, module]));
    const found = new Set();
    const visit = (file) => {
        if (found.has(file)) return;
        found.add(file);
        for (const next of byFile.get(file).imports) visit(next);
    };
    visit(entry);
    return found;
}

/**
 * Builds into `out`, replacing what was there.
 * @param {string} [out]
 * @returns {Promise<{ out: string, files: { path: string, bytes: number, sha256: string, integrity: string }[], list: string, page: string, release: number }>}
 */
export async function build(out = path.join(root, 'dist')) {
    const config = await import(pathToFileURL(path.join(src, 'config.js')).href);
    if (!Number.isInteger(config.RELEASE) || config.RELEASE < 1 || config.RELEASE > RELEASE_LIMITS.release) throw new Error('src/config.js: RELEASE is a whole number from 1 to 2^31 − 1');
    if (config.APP_VERSION !== `web (${config.RELEASE})`) throw new Error(`src/config.js: APP_VERSION is "web (${config.RELEASE})"`);
    if (typeof config.PAGE_NAME !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(config.PAGE_NAME)) throw new Error('src/config.js: PAGE_NAME is the name the page is served under, in lower case');
    if (config.PAGE_ORIGIN !== `https://${config.PAGE_NAME}`) throw new Error('src/config.js: PAGE_ORIGIN is https and PAGE_NAME, with no port and no path');
    if (typeof config.PAGE_PATH !== 'string' || !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(config.PAGE_PATH)) throw new Error('src/config.js: PAGE_PATH is the path the page is served under, starting and ending with a slash: "/" for its origin\'s root');
    if (config.PAGE !== `${config.PAGE_ORIGIN}${config.PAGE_PATH}` || !isPageAddress(config.PAGE)) throw new Error('src/config.js: PAGE is PAGE_ORIGIN and PAGE_PATH together');

    const all = sources().map((file) => moduleOf(file, readFileSync(path.join(src, file), 'utf8')));
    refuseCycles(all);
    const needed = reachable(all, 'main.js');
    const modules = all.filter((module) => needed.has(module.file));
    // What each file was found to export is what it really exports.
    for (const module of modules) {
        const real = Object.keys(await import(pathToFileURL(path.join(src, module.file)).href)).sort();
        if (JSON.stringify(real) !== JSON.stringify([...module.exported].sort())) throw new Error(`${module.file}: found to export ${module.exported.sort()}, and it exports ${real}`);
    }

    const script = [
        `/* Pet Cam Pro camera page, release ${config.RELEASE}. Built by tools/build.mjs from src/: each module below is its`,
        '   source file as written, with only its import and export words taken off. */',
        '(function () {',
        "'use strict';",
        'const __modules = new Map();',
        'const __loaded = new Map();',
        'function __define(name, body) {',
        '    __modules.set(name, body);',
        '}',
        'function __require(name) {',
        '    if (__loaded.has(name)) return __loaded.get(name);',
        '    const exports = {};',
        '    __loaded.set(name, exports);',
        '    __modules.get(name)(exports);',
        '    return exports;',
        '}',
        ...modules.flatMap((module) => [
            '',
            `// ---- src/${module.file} ----`,
            `__define('${module.file}', function (__exports) {`,
            module.body.trimEnd(),
            ...module.exported.map((name) => `__exports.${name} = ${name};`),
            '});',
        ]),
        '',
        "__require('main.js').start();",
        '})();',
        '',
    ].join('\n');
    const style = readFileSync(path.join(src, 'style.css'), 'utf8');
    if (style.includes('\r')) throw new Error('style.css: line ends are \\n');

    const named = (stem, extension, text) => `${stem}.${hash(text, 'sha256', 'hex').slice(0, 16)}.${extension}`;
    const scriptName = named('camera', 'js', script);
    const styleName = named('camera', 'css', style);
    const integrity = (text) => `sha384-${hash(text, 'sha384', 'base64')}`;

    // Only the page's own files, no inline script, no eval; connections only
    // to the Worker. A relay's address isn't a page's to allow or refuse:
    // no policy reaches WebRTC. It guards against mistakes and injected
    // script, not against whoever serves the page.
    const api = new URL(config.API);
    const csp = [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        'img-src data:',
        "media-src 'self' mediastream: blob:",
        `connect-src ${api.origin} wss://${api.host}`,
        "base-uri 'none'",
        "form-action 'none'",
        "require-trusted-types-for 'script'",
        "trusted-types 'none'",
    ].join('; ');

    const fill = { CSP: csp, STYLE: styleName, STYLE_INTEGRITY: integrity(style), SCRIPT: scriptName, SCRIPT_INTEGRITY: integrity(script) };
    const page = readFileSync(path.join(src, 'index.html'), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (_all, key) => {
        if (!(key in fill)) throw new Error(`index.html: nothing to put for {{${key}}}`);
        return fill[key];
    });
    if (page.includes('\r')) throw new Error('index.html: line ends are \\n');

    const written = [[scriptName, script], [styleName, style], ['index.html', page]].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const files = written.map(([name, text]) => ({ path: name, bytes: Buffer.byteLength(text), sha256: hash(text, 'sha256', 'hex'), integrity: integrity(text) }));
    // The list, as the text a signature is made over, for the page's own address.
    const list = releaseListText({ page: config.PAGE, release: config.RELEASE, entry: 'index.html', files });

    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const [name, text] of written) writeFileSync(path.join(out, name), text);
    writeFileSync(path.join(out, 'release.json'), releaseDocument(list));
    return { out, files, list, page: config.PAGE, release: config.RELEASE };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { out, files, page, release } = await build(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
    console.log(`Built release ${release} into ${path.relative(process.cwd(), out) || '.'}:`);
    for (const file of files) console.log(`  ${file.path}  ${file.bytes} bytes  sha256 ${file.sha256}`);
    console.log(`  release.json  unsigned, for ${page}`);
}
