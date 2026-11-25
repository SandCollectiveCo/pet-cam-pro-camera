// A test runner small enough to run the same test files in Node and in a
// browser's page, with nothing installed: the page's crypto is the
// browser's own, so it has to be held to the vectors in each browser.

const registered = [];
let group = '';

/** Names the tests that follow in a file. @param {string} name */
export function suite(name) {
    group = name;
}

/** @param {string} name @param {() => unknown} fn @param {{ only?: 'node' | 'browser' }} [where] */
export function test(name, fn, where = {}) {
    registered.push({ name: group ? `${group}: ${name}` : name, fn, only: where.only ?? null });
}

let notes = [];

/** Something a test found, kept with its result whether it passes or not. @param {string} text */
export function note(text) {
    notes.push(text);
}

/** Where this is running. */
export const inBrowser = typeof document !== 'undefined';

class Failed extends Error {
    constructor(message) {
        super(message);
        this.name = 'Failed';
    }
}

/** @param {unknown} value */
function show(value) {
    if (value instanceof Uint8Array) return `bytes(${Array.from(value.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join('')}${value.length > 24 ? '…' : ''}, ${value.length})`;
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text.length > 300 ? `${text.slice(0, 300)}…` : text;
    } catch {
        return String(value);
    }
}

/** @param {unknown} a @param {unknown} b @returns {boolean} */
function same(a, b) {
    if (Object.is(a, b)) return true;
    if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, i) => byte === b[i]);
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((item) => b.has(item));
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    return keysA.length === keysB.length && keysA.every((k) => same(a[k], b[k]));
}

export const assert = {
    /** @param {unknown} value @param {string} [message] */
    ok(value, message) {
        if (!value) throw new Failed(message ?? `expected something true, got ${show(value)}`);
    },
    /** Values that are the same all the way down; bytes compare as bytes.
     * @param {unknown} actual @param {unknown} expected @param {string} [message] */
    equal(actual, expected, message) {
        if (!same(actual, expected)) throw new Failed(`${message ? `${message}: ` : ''}got ${show(actual)}, expected ${show(expected)}`);
    },
    /** @param {unknown} actual @param {unknown} unexpected @param {string} [message] */
    notEqual(actual, unexpected, message) {
        if (same(actual, unexpected)) throw new Failed(`${message ? `${message}: ` : ''}got ${show(actual)}, which it shouldn't be`);
    },
    /** @param {() => unknown} fn @param {string} [message] @returns {Promise<any>} what it threw */
    async throws(fn, message) {
        try {
            await fn();
        } catch (error) {
            return error;
        }
        throw new Failed(message ?? 'expected a throw');
    },
};

/** Waits until `check` gives something true, looking every `every` ms.
 * @template T @param {() => T | Promise<T>} check @param {string} what @param {number} [within] ms @param {number} [every] ms @returns {Promise<T>} */
export async function until(check, what, within = 15_000, every = 50) {
    const start = Date.now();
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() - start > within) throw new Failed(`waited ${within} ms for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, every));
    }
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One of the copied vector files (vectors/<name>.json): each runner says how
 * to read one where it runs. @param {string} name @returns {Promise<any>} */
export function vectors(name) {
    const load = globalThis.petcamTestVectors;
    if (typeof load !== 'function') throw new Error('the runner sets how vectors are read');
    return load(name);
}

/** Runs every registered test, in order.
 * @param {{ filter?: string, each?: (result: { name: string, ok: boolean, ms: number, error?: string, skipped?: boolean }) => void }} [how] */
export async function runAll(how = {}) {
    const results = [];
    for (const { name, fn, only } of registered) {
        if (how.filter && !name.includes(how.filter)) continue;
        if (only && only !== (inBrowser ? 'browser' : 'node')) {
            const skipped = { name, ok: true, ms: 0, skipped: true };
            results.push(skipped);
            how.each?.(skipped);
            continue;
        }
        const start = Date.now();
        let result;
        notes = [];
        try {
            await fn();
            result = { name, ok: true, ms: Date.now() - start };
        } catch (error) {
            result = { name, ok: false, ms: Date.now() - start, error: error instanceof Failed ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}\n${error?.stack ?? ''}` };
        }
        if (notes.length > 0) result.notes = notes;
        results.push(result);
        how.each?.(result);
    }
    return results;
}
