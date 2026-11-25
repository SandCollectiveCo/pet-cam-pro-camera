// The page's own screen (docs/WEB-CAMERA.md § 5, Its own screen). A camera
// says whose it is, that it's live or what's stopping it, who's watching,
// until when, and which camera and microphone it's using, and has Stop. Left
// alone it goes black, with a faint clock that moves and those same few
// lines, faint; a tap brings its controls back.
//
// Every page is drawn from a plain description and nothing else, with the
// browser's own elements and `textContent`: nothing here ever writes HTML
// from text.

import { WORDS } from '../words.js';
import { clockTime } from './when.js';

/** How long the controls stay up after the last touch. */
export const LIT_FOR_MS = 30_000;
/** How often the faint clock moves, so no part of a screen shows it for long. */
const CLOCK_MOVES_EVERY_MS = 60_000;

/**
 * What to show.
 * @typedef {{ kind: 'message', text: string }
 *   | { kind: 'joining', code: string | null }
 *   | { kind: 'ready', startedBy: string | null, endsAt: number, starting: boolean, blocked: 'denied' | 'missing' | 'failed' | null, onStart: () => void }
 *   | { kind: 'camera', view: import('../camera/camera.js').CameraView, on: { stop: () => void, camera: (deviceId: string) => void, microphone: (deviceId: string) => void, ownMicrophone: () => void, tryAgain: () => void } }
 *   | { kind: 'ended', why: 'time' | 'home' | 'here' | 'gone' | 'over' | 'elsewhere' }} Page
 */

export class Screen {
    /**
     * @param {Document} doc
     * @param {HTMLElement} root the page's one container
     * @param {import('../device.js').DeviceKind} device
     * @param {{ now: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void, setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (id: any) => void, random?: () => number }} clock
     */
    constructor(doc, root, device, clock) {
        this.doc = doc;
        this.device = device;
        this.clock = clock;
        this.random = clock.random ?? Math.random;
        /** @type {Page | null} */
        this.page = null;
        /** The camera's controls are up. */
        this.lit = true;
        /** Stop was tapped, and the page is asking. */
        this.asking = false;
        /** Which of the two rows is open to pick another device from. @type {'camera' | 'microphone' | null} */
        this.choosing = null;
        this.litTimer = null;
        this.clockTimer = null;
        this.place = { left: 50, top: 42 };

        this.sheet = this.el('div', 'sheet');
        // The camera's own look at its picture. It stays where it is in the
        // page for as long as the page lives: a video that's moved may stop.
        this.video = /** @type {HTMLVideoElement} */ (this.el('video'));
        this.video.id = 'look';
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.autoplay = true;
        this.video.setAttribute('aria-hidden', 'true');
        // It is the page's one media element, and it never sounds: there is
        // no Talk in the first version, so nothing here plays what a viewer
        // sends.
        this.sheet.append(this.video);
        root.replaceChildren(this.sheet);
    }

    /** @param {string} tag @param {string} [className] @param {string | null} [text] @returns {HTMLElement} */
    el(tag, className, text) {
        const element = this.doc.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = text;
        return element;
    }

    /** @param {string} className @param {string} text @param {() => void} onTap */
    button(className, text, onTap) {
        const button = /** @type {HTMLButtonElement} */ (this.el('button', className, text));
        button.type = 'button';
        button.addEventListener('click', onTap);
        return button;
    }

    /** A small eye, drawn: who's watching. */
    eye() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = this.doc.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 18 12');
        svg.setAttribute('class', 'eye');
        svg.setAttribute('aria-hidden', 'true');
        const lid = this.doc.createElementNS(NS, 'path');
        lid.setAttribute('d', 'M9 0C5 0 1.7 2.4 0 6c1.7 3.6 5 6 9 6s7.3-2.4 9-6c-1.7-3.6-5-6-9-6Zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-6.2a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z');
        lid.setAttribute('fill', 'currentColor');
        svg.append(lid);
        return svg;
    }

    /** Shows a page. The camera's own page is shown again each time what it says changes. @param {Page} page */
    show(page) {
        const was = this.page?.kind;
        this.page = page;
        if (page.kind !== 'camera') {
            this.asking = false;
            this.choosing = null;
            this.stopTimers();
            this.lit = true;
        } else if (was !== 'camera') {
            // A camera that just started shows its controls, then goes dark.
            this.touch();
            this.clockTimer = this.clock.setInterval(() => this.moveClock(), CLOCK_MOVES_EVERY_MS);
        }
        this.draw();
    }

    stopTimers() {
        this.clock.clearTimeout(this.litTimer);
        this.clock.clearInterval(this.clockTimer);
        this.litTimer = null;
        this.clockTimer = null;
    }

    /** Someone touched the camera's page: its controls come up, and go again when it's left alone. */
    touch() {
        this.lit = true;
        this.clock.clearTimeout(this.litTimer);
        this.litTimer = this.clock.setTimeout(() => {
            this.lit = false;
            this.asking = false;
            this.choosing = null;
            this.draw();
        }, LIT_FOR_MS);
    }

    /** The faint clock goes somewhere else, and reads the time again. */
    moveClock() {
        this.place = { left: 22 + this.random() * 56, top: 20 + this.random() * 52 };
        if (this.page?.kind === 'camera' && !this.lit) this.draw();
    }

    draw() {
        const page = this.page;
        if (!page) return;
        /** @type {(Node | null)[]} */
        let parts;
        let lit = false;
        let centered = true;
        switch (page.kind) {
            case 'message':
                parts = [this.el('p', 'words', page.text)];
                break;
            case 'joining':
                parts = page.code === null ? [this.el('p', 'soft', WORDS.asking)] : [this.el('p', 'code', page.code), this.el('p', 'soft', WORDS.compare)];
                break;
            case 'ready':
                parts = this.ready(page);
                break;
            case 'ended':
                parts = this.ended(page);
                break;
            default:
                lit = this.lit;
                centered = !lit;
                parts = lit ? this.controls(page) : [this.resting(page)];
                break;
        }
        this.doc.body.classList.toggle('lit', lit);
        this.sheet.className = centered ? 'sheet center' : 'sheet';
        // Everything but the one element that has to stay put.
        for (const child of [...this.sheet.children]) if (child !== this.video) child.remove();
        this.sheet.append(...parts.filter(Boolean));
    }

    /** @param {Extract<Page, { kind: 'ready' }>} page */
    ready(page) {
        const start = this.button('primary', page.starting ? WORDS.starting : WORDS.start, () => page.onStart());
        start.disabled = page.starting;
        return [
            this.el('p', 'words', WORDS.borrowing(page.startedBy, this.device.noun, page.endsAt, this.clock.now())),
            page.blocked ? this.el('p', 'warn', WORDS.blocked[page.blocked]) : null,
            start,
            this.device.runsTheApp ? this.el('p', 'soft', WORDS.appIsBetter(this.device.name)) : null,
        ];
    }

    /** @param {Extract<Page, { kind: 'ended' }>} page */
    ended(page) {
        if (page.why === 'elsewhere') return [this.el('p', 'words', WORDS.elsewhere)];
        const because = WORDS.doneBecause[page.why];
        return [
            this.el('p', 'words', WORDS.done(this.device.noun)),
            because ? this.el('p', 'soft', because) : null,
            this.el('p', 'soft', WORDS.permission),
        ];
    }

    /** Live, or what's stopping it: the words, and the dot's colour.
     * @param {import('../camera/camera.js').CameraView} view */
    state(view) {
        if (view.live) return { text: WORDS.live, dot: view.watching.length > 0 ? 'dot watched' : 'dot', stopped: false };
        const words = WORDS.stopping[view.stopping[0]] ?? WORDS.stopping.stalled;
        return { text: typeof words === 'function' ? words(this.device.noun) : words, dot: 'dot stopped', stopped: true };
    }

    /** @param {import('../camera/camera.js').CameraView} view */
    watchingLine(view) {
        const text = WORDS.watching(view.watching);
        if (!text) return null;
        const line = this.el('p', 'watching');
        line.append(this.eye(), this.el('span', '', text));
        return line;
    }

    /** The camera's controls. @param {Extract<Page, { kind: 'camera' }>} page */
    controls(page) {
        const { view, on } = page;
        const state = this.state(view);
        const again = () => {
            this.touch();
            this.draw();
        };

        const status = this.el('p', state.stopped ? 'status stopped' : 'status');
        status.setAttribute('role', 'status');
        status.append(this.el('span', state.dot), this.el('span', '', state.text));
        const head = this.el('div', 'head');
        head.append(status, this.el('p', 'whose', WORDS.whose(view.startedBy)), this.el('p', 'soft', WORDS.until(view.endsAt, this.clock.now())));
        const watching = this.watchingLine(view);
        if (watching) head.append(watching);

        const rows = this.el('div', 'rows');
        /** @param {'camera' | 'microphone'} which @param {string} caption @param {{ name: string, deviceId: string | null } | null} using @param {{ deviceId: string, name: string }[]} others @param {(deviceId: string) => void} pick */
        const row = (which, caption, using, others, pick) => {
            const button = this.button('row', null, () => {
                this.choosing = this.choosing === which ? null : which;
                again();
            });
            button.append(this.el('span', '', caption), this.el('span', 'name', using?.name || '—'));
            button.setAttribute('aria-expanded', String(this.choosing === which));
            rows.append(button);
            if (this.choosing !== which) return;
            const choices = this.el('div', 'choices');
            for (const other of others) {
                const current = other.deviceId === using?.deviceId;
                choices.append(this.button(current ? 'choice current' : 'choice', other.name, () => {
                    this.choosing = null;
                    if (!current) pick(other.deviceId);
                    again();
                }));
            }
            if (others.length > 0) rows.append(choices);
        };
        row('camera', WORDS.camera, view.using.camera, view.using.cameras, on.camera);
        row('microphone', WORDS.microphone, view.using.microphone, view.using.microphones, on.microphone);

        const notes = this.el('div', 'notes');
        const microphone = view.using.microphone;
        // The microphone isn't the device's own, as far as the page can tell: it says so.
        if (microphone?.whose === 'other') {
            notes.append(this.el('p', 'warn', WORDS.soundFrom(microphone.name, this.device.this)));
            if (view.using.hasOwnMicrophone) {
                notes.append(this.button('quiet', WORDS.useOwn(this.device.this), () => {
                    on.ownMicrophone();
                    again();
                }));
            }
        }
        if (view.stopping.some((why) => why === 'denied' || why === 'missing' || why === 'failed')) {
            notes.append(this.button('primary', WORDS.start, () => {
                on.tryAgain();
                again();
            }));
        }
        if (view.silent) notes.append(this.el('p', 'warn', WORDS.silent));
        if (view.charging === false) notes.append(this.el('p', 'warn', WORDS.plugIn(this.device.noun)));
        notes.append(this.el('p', 'soft', WORDS.keep));

        const foot = this.el('div', 'foot');
        if (this.asking) {
            const pair = this.el('div', 'pair');
            pair.append(
                this.button('quiet', WORDS.stopNo, () => {
                    this.asking = false;
                    again();
                }),
                this.button('quiet danger', WORDS.stopYes, () => on.stop()),
            );
            foot.append(this.el('p', 'asks', WORDS.stopAsks), pair);
        } else {
            foot.append(this.button('quiet danger', WORDS.stop, () => {
                this.asking = true;
                again();
            }));
        }
        return [head, rows, notes, foot];
    }

    /** The page at rest: black, a faint clock, and the same few lines, faint.
     * @param {Extract<Page, { kind: 'camera' }>} page */
    resting(page) {
        const { view } = page;
        const state = this.state(view);
        const dark = this.button('dark', null, () => {
            this.touch();
            this.draw();
        });
        dark.setAttribute('aria-label', `${state.text}. ${WORDS.whose(view.startedBy)}, ${WORDS.until(view.endsAt, this.clock.now())}. ${WORDS.wake}`);
        const rest = this.el('div', 'rest');
        rest.style.setProperty('left', `${this.place.left}%`);
        rest.style.setProperty('top', `${this.place.top}%`);
        const clock = this.el('p', 'clock', clockTime(this.clock.now()));
        clock.setAttribute('aria-hidden', 'true');
        const line = this.el('p', state.stopped ? 'line stopped' : 'line');
        line.append(this.el('span', state.dot), this.el('span', '', `${state.text} · ${WORDS.whose(view.startedBy)}`));
        rest.append(clock, line, this.el('p', 'line', WORDS.until(view.endsAt, this.clock.now())));
        const watching = this.watchingLine(view);
        if (watching) rest.append(watching);
        dark.append(rest);
        return dark;
    }
}
