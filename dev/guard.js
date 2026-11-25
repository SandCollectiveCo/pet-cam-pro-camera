// A page in dev/ never has a real camera or microphone: it feeds itself a
// drawn picture and a made tone (drawn.js). The server already tells the
// browser to refuse both to these pages; this makes the same refusal in the
// page, so a mistake fails loudly and at once.
//
// The refusal goes on the prototype, not only on `navigator.mediaDevices`
// itself. Safari hands out a fresh object for that when the old one has
// been collected, without anything a page put on it, and it doesn't honour
// the server's Permissions-Policy for a page: on 2026-11-24 a test that
// relied on both was given a Mac's real camera and microphone for three
// seconds. So: on the prototype, checked before anything runs, and nothing
// in dev/ or test/ ever calls the browser's own getUserMedia.

const refuse = () => Promise.reject(new DOMException('A dev page never opens a real camera or microphone.', 'NotAllowedError'));
Object.defineProperty(refuse, 'petcamRefusal', { value: true });

export function refuseRealDevices() {
    const targets = [globalThis.MediaDevices?.prototype, navigator.mediaDevices].filter(Boolean);
    for (const target of targets) {
        for (const name of ['getUserMedia', 'getDisplayMedia']) {
            try {
                Object.defineProperty(target, name, { value: refuse, configurable: false, writable: false });
            } catch {
                try {
                    target[name] = refuse;
                } catch {
                    // Checked below, by whoever relies on it.
                }
            }
        }
    }
    // Kept reachable, so the object that carries the refusal isn't dropped.
    globalThis.petcamGuardedDevices = navigator.mediaDevices;
}

/** Whether asking for a camera or a microphone from this page is refused by
 * the page itself, whatever the browser would have said. Looked at before
 * anything is asked for. */
export function realDevicesAreRefused() {
    const devices = navigator.mediaDevices;
    return !devices || (devices.getUserMedia?.petcamRefusal === true && (devices.getDisplayMedia === undefined || devices.getDisplayMedia?.petcamRefusal === true));
}

/** What the refusal looks like from here, for a test to hold it to: found
 * by looking, never by asking for a device. */
export function refusalFacts() {
    const prototype = globalThis.MediaDevices?.prototype;
    const described = prototype && Object.getOwnPropertyDescriptor(prototype, 'getUserMedia');
    return {
        inPlace: realDevicesAreRefused(),
        onPrototype: prototype?.getUserMedia?.petcamRefusal === true,
        whatAPageFinds: navigator.mediaDevices?.getUserMedia === prototype?.getUserMedia ? 'the refusal' : 'something else',
        canBePutBack: Boolean(described?.writable || described?.configurable),
    };
}
