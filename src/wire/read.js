// Reading JSON as the apps read it (docs/vectors/wire-v1.json): a field the
// reader doesn't know is passed over, null reads as missing, and a field of
// the wrong type refuses the whole message, as if it never came. A number is
// never text, and true is never 1.

/** A message that doesn't read. */
export class Refused extends Error {
    /** @param {string} why */
    constructor(why) {
        super(why);
        this.name = 'Refused';
    }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const CHECKS = {
    bool: (value) => typeof value === 'boolean',
    string: (value) => typeof value === 'string',
    number: (value) => typeof value === 'number' && Number.isFinite(value),
    int: (value) => typeof value === 'number' && Number.isInteger(value),
};

/** A field that may be missing: its value, or null when it's missing or null.
 * @param {Record<string, unknown>} from @param {string} key @param {'bool' | 'string' | 'number' | 'int'} type @returns {any} */
export function optional(from, key, type) {
    const value = from[key];
    if (value === undefined || value === null) return null;
    if (!CHECKS[type](value)) throw new Refused(`${key} isn't ${type}`);
    return value;
}

/** A field that has to be there.
 * @param {Record<string, unknown>} from @param {string} key @param {'bool' | 'string' | 'number' | 'int'} type @returns {any} */
export function required(from, key, type) {
    const value = optional(from, key, type);
    if (value === null) throw new Refused(`no ${key}`);
    return value;
}

/** An object that has to be there. @param {unknown} value @param {string} what @returns {Record<string, unknown>} */
export function object(value, what) {
    if (!isObject(value)) throw new Refused(`${what} isn't an object`);
    return value;
}

/** Turns a reader that throws `Refused` into one that gives null for what
 * doesn't read. Anything else it throws is a fault here, and goes on up.
 * @template T @param {(json: unknown) => T} read @returns {(json: unknown) => T | null} */
export function reader(read) {
    return (json) => {
        try {
            return read(json);
        } catch (error) {
            if (error instanceof Refused) return null;
            throw error;
        }
    };
}
