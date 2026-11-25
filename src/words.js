// Every word the page shows, in one place.
//
// Every one is picked: the plan's own (docs/WEB-CAMERA.md §§ 1, 4 and 5,
// 2026-11-19), the apps' words for the same thing, and the rest, written
// with the page and picked on 2026-11-24, each from two or three drafts.
// WORDS.md lists them all. A new word is a draft until it's picked too.
//
// The page says what happens, to which device: "this phone", never "it".
// A label says what it is, with nothing under it.

import { inPhrase } from './names.js';
import { until } from './ui/when.js';

/** What a watching device is called when its call didn't say (the apps' own word). */
const UNNAMED = 'Another device';

export const WORDS = Object.freeze({
    /** The browser tab's name. */
    title: 'Pet Cam Pro camera',

    // ---- Before it's a camera ---------------------------------------------

    /** The page opened with no code scanned and nothing kept. */
    nothing: 'To use this as a camera, scan the code a Pet Cam Pro viewer shows.',
    /** A browser that can't meet a camera's terms, or isn't one the first version takes. */
    unsupported: "This browser can't be a camera. Use Chrome or Safari, up to date.",
    /** Asking, before the code exists. */
    asking: 'Asking the viewer…',
    /** Under the six digits; the apps say "Approve only if the codes match." on the other side. */
    compare: 'Tap Approve on the viewer if it shows this code.',
    /** Turned down, or the code was used or too old. */
    turned: Object.freeze({
        denied: "The viewer didn't approve this camera.",
        expired: 'That code has been used or is too old. Start again from the viewer.',
        invalid: "That link isn't one Pet Cam Pro made.",
    }),

    // ---- Approved ----------------------------------------------------------

    /** The plan's: "Maya Lopez is borrowing this phone as a camera until tomorrow, 2:10 PM."
     * Where its pass named nobody: "This phone is being borrowed as a camera until tomorrow, 2:10 PM."
     * @param {string | null} startedBy @param {string} noun phone, tablet, computer @param {number} endsAt @param {number} now */
    borrowing: (startedBy, noun, endsAt, now) => (startedBy === null ? `This ${noun} is being borrowed as a camera ${until(endsAt, now)}.` : `${inPhrase(startedBy)} is borrowing this ${noun} as a camera ${until(endsAt, now)}.`),
    /** The apps' own button. */
    start: 'Start the camera',
    /** On an iPhone or iPad only (decision 8). @param {string} device "iPhone" */
    appIsBetter: (device) => `Keeping this ${device} as a camera? Use the Pet Cam Pro app instead.`,
    /** The button, while the browser is asking the person. */
    starting: 'Starting the camera…',
    /** The person said no, or the browser did. */
    blocked: Object.freeze({
        denied: 'The camera and microphone are off for this page. Allow both, then tap Start the camera.',
        missing: 'No camera found.',
        failed: "The camera didn't start.",
    }),

    // ---- A camera ----------------------------------------------------------

    /** Whose camera it is: "Maya Lopez’s camera", and where its pass named nobody, what a viewer calls one: "Temporary camera".
     * @param {string | null} startedBy */
    whose: (startedBy) => (startedBy === null ? 'Temporary camera' : `${inPhrase(startedBy)}’s camera`),
    /** The apps' own word. */
    live: 'Live',
    /** What's stopping it, where it isn't live. */
    stopping: Object.freeze({
        stalled: 'No picture from the camera',
        denied: 'The camera is off for this page',
        missing: 'No camera found',
        failed: "The camera didn't start",
        offline: 'No connection. Trying again.',
        /** @param {string} noun phone, tablet, computer */
        clock: (noun) => `This ${noun}’s clock is wrong, so nobody can watch. Set the date and time.`,
        /** The home's plan ran out while the camera lives: it stays a camera, and nothing here puts it right. */
        plan: 'Nobody can watch: the Pet Cam Pro plan this camera runs on has ended.',
    }),
    /** A picture with no sound: no microphone, or one that stopped. */
    silent: 'No sound from the microphone.',
    /** The plan's: "until tomorrow, 2:10 PM". @param {number} endsAt @param {number} now */
    until: (endsAt, now) => until(endsAt, now),
    /**
     * Who's watching, in one line, as the apps' cameras say it: "Kitchen
     * iPad watching", "Kitchen iPad and Maya’s iPhone watching", "Kitchen
     * iPad and 2 more watching". Nothing with nobody watching.
     * Where a call didn't say who's calling: "Someone is watching".
     * @param {(string | null)[]} names
     */
    watching(names) {
        if (names.length === 0) return null;
        if (names.every((name) => name === null)) return names.length === 1 ? 'Someone is watching' : `${names.length} devices watching`;
        const said = names.map((name) => name ?? UNNAMED).sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })).map(inPhrase);
        if (said.length === 1) return `${said[0]} watching`;
        if (said.length === 2) return `${said[0]} and ${said[1]} watching`;
        return `${said[0]} and ${said.length - 1} more watching`;
    },
    /** The two rows' captions, each row a button that changes what it names. */
    camera: 'Camera',
    microphone: 'Microphone',
    /** The first of the plan's three drafts for this line (§ 4), picked 2026-11-24: "Sound is coming from AirPods, not this Mac."
     * @param {string} microphone @param {string} device "this Mac" */
    soundFrom: (microphone, device) => `Sound is coming from ${microphone}, not ${device}.`,
    /** The plan's (§ 4): "Use this Mac's microphone". @param {string} device "this Mac" */
    useOwn: (device) => `Use ${device}’s microphone`,
    /** A page can't dim a screen or keep itself in front. */
    keep: "Leave this page open and in front. Turn the screen's brightness down.",
    /** Where the browser says it isn't charging. @param {string} noun */
    plugIn: (noun) => `Plug this ${noun} in.`,
    /** The plan's (§ 5). */
    stop: 'Stop',
    /** Stop can't be undone from here: the apps ask too, with these button words. */
    stopAsks: 'Stop the camera?',
    stopYes: 'Stop Camera',
    stopNo: 'Cancel',
    /** For a screen reader: the dark page lights at a tap. */
    wake: 'Show the camera’s controls',

    // ---- Over --------------------------------------------------------------

    /** The plan's: "That's the camera done. Close the page and it's just a phone again." @param {string} noun */
    done: (noun) => `That’s the camera done. Close the page and it’s just a ${noun} again.`,
    /** Why, where it wasn't stopped right here. */
    doneBecause: Object.freeze({
        time: 'The camera’s time was up.',
        home: 'A viewer ended the camera.',
        here: null,
        gone: 'A viewer ended the camera.',
        over: 'The camera’s time was up.',
    }),
    /** The one thing that can outlast the camera on someone else's device. */
    permission: 'If you let this page use the camera every time, you can take that back in the browser’s settings for this site.',
    /** The same camera, open in another tab. */
    elsewhere: 'This camera is running in another tab. Close this one.',
});
