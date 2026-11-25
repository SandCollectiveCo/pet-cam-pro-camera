// What kind of device this page is on, as far as the page can tell: what
// it says it is when it registers (its `model`, which the home calls it by
// until someone names it: docs/API.md, Temporary cameras, Its name) and the
// plain word the page's own lines use for it.
//
// The model is one of eight words, exactly, and never anything else: the
// apps show a `web` device's model only when it is one of them
// (vectors/temporary-camera-v1.json, `models`).

/**
 * @typedef {object} DeviceKind
 * @property {'iphone' | 'ipad' | 'android_phone' | 'android_tablet' | 'mac' | 'windows' | 'chromebook' | 'computer'} kind
 * @property {string} name its `model` as it registers, and what the home lists it as: "Android phone"
 * @property {'phone' | 'tablet' | 'computer'} noun for "borrowing this phone as a camera"
 * @property {string} this for "this Mac's microphone": "this Mac", "this phone"
 * @property {boolean} runsTheApp an iPhone or iPad: the page says the app is the better camera for one that will stay a camera (decision 8)
 */

const KINDS = Object.freeze({
    iphone: { name: 'iPhone', noun: 'phone', this: 'this iPhone', runsTheApp: true },
    ipad: { name: 'iPad', noun: 'tablet', this: 'this iPad', runsTheApp: true },
    android_phone: { name: 'Android phone', noun: 'phone', this: 'this phone', runsTheApp: false },
    android_tablet: { name: 'Android tablet', noun: 'tablet', this: 'this tablet', runsTheApp: false },
    mac: { name: 'Mac', noun: 'computer', this: 'this Mac', runsTheApp: false },
    windows: { name: 'Windows PC', noun: 'computer', this: 'this PC', runsTheApp: false },
    chromebook: { name: 'Chromebook', noun: 'computer', this: 'this Chromebook', runsTheApp: false },
    // A computer the page can tell no more about (Linux, say).
    computer: { name: 'Computer', noun: 'computer', this: 'this computer', runsTheApp: false },
});

/** Every word a page may say it is: its `model`. */
export const MODELS = Object.freeze(Object.values(KINDS).map((kind) => kind.name));

/**
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number }} agent a browser's `navigator`
 * @returns {DeviceKind}
 */
export function deviceKind(agent) {
    const ua = agent.userAgent ?? '';
    /** @type {DeviceKind['kind']} */
    let kind = 'computer';
    if (/iPhone|iPod/.test(ua)) kind = 'iphone';
    // An iPad says it's a Mac unless asked for the mobile site; a Mac has no touch screen.
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (agent.maxTouchPoints ?? 0) > 1)) kind = 'ipad';
    else if (/Android/.test(ua)) kind = /Mobile/.test(ua) ? 'android_phone' : 'android_tablet';
    else if (/CrOS/.test(ua)) kind = 'chromebook';
    else if (/Windows/.test(ua)) kind = 'windows';
    else if (/Macintosh|Mac OS X/.test(ua)) kind = 'mac';
    return { kind, ...KINDS[kind] };
}
