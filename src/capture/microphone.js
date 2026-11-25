// Which microphone a camera is listening through (docs/WEB-CAMERA.md § 4,
// Which microphone). A page that asks for a microphone without naming one
// gets whichever the system is using, and that isn't always the device's
// own: on 2026-11-19 Safari on a Mac handed a test page its owner's AirPods.
// A camera set up like that hears wherever the earbuds are, not its room.
//
// A page can't forbid a headset as the app's audio session does. It can ask
// for the device's own where it can tell which that is, read what it was
// really given off the track, and say so on its screen. The names here are
// what browsers call microphones; the list is kept with the page and is
// never complete, and what it doesn't know it calls unknown and says
// nothing about.

/** A microphone someone wears or carries: wherever it is, it isn't the room. */
const WORN = /airpods|beats|\bbuds\b|earbuds|earphone|earpods|headset|headphone|hands-?free|bluetooth|jabra|plantronics|\bpoly\b|sennheiser|\bbose\b|\bsony (wh|wf)-|\bjbl\b|powerbeats|galaxy buds|pixel buds/i;

/** What each kind of device's browsers call its own microphone. */
const OWN = Object.freeze({
    mac: [/\b(macbook( pro| air)?|imac( pro)?|mac (mini|studio|pro)|studio display|built-in) microphone\b/i, /\(built-in\)/i],
    iphone: [/\biphone\b/i],
    ipad: [/\bipad\b/i],
    // Chrome on Android names routes, not parts: the speakerphone route is the phone's own microphone.
    android_phone: [/^speakerphone$/i],
    android_tablet: [/^speakerphone$/i],
    windows: [/microphone array/i, /\b(internal|built-in|integrated) microphone\b/i],
    chromebook: [/\binternal mic/i],
    computer: [/\b(internal|built-in|integrated) microphone\b/i],
});

/** A phone's microphone lent to a computer (Continuity) is carried, too. */
const A_PHONES = /\b(iphone|ipad)\b/i;

/**
 * Whose microphone a name is, as far as the page can tell.
 * @param {string} label a track's or a listed device's name
 * @param {import('../device.js').DeviceKind['kind']} kind what this device is
 * @returns {'own' | 'other' | 'unknown'}
 */
export function whoseMicrophone(label, kind) {
    const name = label.trim();
    if (name === '') return 'unknown';
    if (WORN.test(name)) return 'other';
    if ((OWN[kind] ?? []).some((pattern) => pattern.test(name))) return 'own';
    if (kind !== 'iphone' && kind !== 'ipad' && A_PHONES.test(name)) return 'other';
    return 'unknown';
}

/** A name as a person would say it: what a browser adds around it taken
 * off ("Default - MacBook Pro Microphone (Built-in)").
 * @param {string} label */
export function plainName(label) {
    return label.replace(/^(default|communications)\s*-\s*/i, '').replace(/\s*\((built-in|[0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i, '').trim();
}

/**
 * The device's own microphone among those the browser lists, or null when
 * none can be told for it. A browser's "Default" entry is whatever the
 * system is using, so it's never the answer.
 * @param {{ deviceId: string, label: string, kind: string }[]} devices as `enumerateDevices` lists them
 * @param {import('../device.js').DeviceKind['kind']} kind
 * @returns {{ deviceId: string, label: string } | null}
 */
export function ownMicrophone(devices, kind) {
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== '');
    return inputs.find((d) => whoseMicrophone(d.label, kind) === 'own') ?? null;
}
