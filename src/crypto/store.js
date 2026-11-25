// What a temporary camera keeps between visits: its own key pair, the keys
// from its pass, its session, its end. They're kept in the browser's own
// storage (IndexedDB), which stores a key that can't be read out as just
// that: the page gets it back usable, and still can't read it
// (docs/WEB-CAMERA.md § 3, § 4).
//
// One database, named for this page alone: nothing else an origin may have
// held is read (an earlier test page left a diary under other keys), and at
// the camera's end the whole database goes.
//
// The browser doesn't promise to keep it (asked to, Safari on a Mac said
// no): a page opened again after its storage was cleared has no key, and
// that camera is over until a viewer starts another.

/** The database's name, and so every key this page reads. */
export const STORE_NAME = 'petcam-camera-v1';
const KEPT = 'kept';

/**
 * @typedef {object} Store
 * @property {(key: string) => Promise<any>} get undefined when there's none
 * @property {(key: string, value: unknown) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 * @property {() => Promise<void>} clear everything, for good
 */

/** @param {IDBRequest | IDBOpenDBRequest} request @returns {Promise<any>} */
const settled = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage refused'));
    if ('onblocked' in request) request.onblocked = () => reject(new Error('storage is in use elsewhere'));
});

/** The browser's storage. @param {IDBFactory} [factory] @returns {Store} */
export function browserStore(factory = globalThis.indexedDB) {
    /** @type {Promise<IDBDatabase> | null} */
    let opening = null;
    const open = () => {
        opening ??= (() => {
            const request = factory.open(STORE_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(KEPT);
            return settled(request).then((db) => {
                // Deleted from another tab, or an upgrade there: let go, and open again when next asked.
                db.onversionchange = () => {
                    db.close();
                    opening = null;
                };
                return db;
            }, (error) => {
                opening = null;
                throw error;
            });
        })();
        return opening;
    };
    /** @param {IDBTransactionMode} mode @param {(kept: IDBObjectStore) => IDBRequest} work */
    const run = async (mode, work) => {
        const db = await open();
        const transaction = db.transaction(KEPT, mode);
        const done = new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve(undefined);
            transaction.onabort = () => reject(transaction.error ?? new Error('storage refused'));
        });
        const result = await settled(work(transaction.objectStore(KEPT)));
        await done;
        return result;
    };
    return {
        get: (key) => run('readonly', (kept) => kept.get(key)),
        set: async (key, value) => {
            await run('readwrite', (kept) => kept.put(value, key));
        },
        remove: async (key) => {
            await run('readwrite', (kept) => kept.delete(key));
        },
        clear: async () => {
            const db = await opening?.catch(() => null);
            db?.close();
            opening = null;
            await settled(factory.deleteDatabase(STORE_NAME));
        },
    };
}

/** Kept only while the page lives: where there's no storage to keep it in. @returns {Store} */
export function memoryStore() {
    const kept = new Map();
    return {
        get: async (key) => kept.get(key),
        set: async (key, value) => {
            kept.set(key, value);
        },
        remove: async (key) => {
            kept.delete(key);
        },
        clear: async () => {
            kept.clear();
        },
    };
}
