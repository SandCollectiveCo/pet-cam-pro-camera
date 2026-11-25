// A command: what a member's device tells a camera to do, sealed, with when
// it was sent and an id (docs/API.md, Sealed messages and Realtime). A
// camera carries one out only if it was sent within two minutes of its own
// clock, either way, and it hasn't carried that id out already, so a
// replayed command does nothing.

import { object, optional, reader, required } from './read.js';

/** How far from the camera's clock a command may have been sent. */
export const COMMAND_WINDOW_MS = 120_000;

/** How long the ids a camera carried out are kept, across reloads: longer
 * than the window, so nothing older can come again. */
export const SEEN_KEPT_MS = 300_000;

/** The most a `peek` asks for at once, in seconds. */
export const PEEK_MAX_SECONDS = 35;

/**
 * @typedef {object} Command
 * @property {{ name: string, on: boolean | null, value: number | null, text: string | null }} command
 * @property {number} sentAt
 * @property {string} id
 */

/** A command as the apps read one, or null for one they'd refuse. A name
 * nobody knows still reads: a camera does nothing for it.
 * @type {(json: unknown) => Command | null} */
export const readCommand = reader((json) => {
    const from = object(json, 'a command');
    const inner = object(from.command, 'its command');
    return {
        command: {
            name: required(inner, 'name', 'string'),
            on: optional(inner, 'on', 'bool'),
            value: optional(inner, 'value', 'number'),
            text: optional(inner, 'text', 'string'),
        },
        sentAt: required(from, 'sent_at', 'int'),
        id: required(from, 'id', 'string'),
    };
});

/** Whether `command` can be carried out at `now`: sent within two minutes
 * either way of it, and not among `seen`.
 * @param {Command} command @param {number} now ms @param {{ has(id: string): boolean }} seen */
export function commandIsFresh(command, now, seen) {
    const gap = now - command.sentAt;
    return gap > -COMMAND_WINDOW_MS && gap < COMMAND_WINDOW_MS && !seen.has(command.id);
}

/** The ids a camera carried out lately, which it keeps across reloads. */
export class SeenCommands {
    /** @param {Record<string, number>} [kept] id → when it was carried out (ms) */
    constructor(kept = {}) {
        /** @type {Map<string, number>} */
        this.ids = new Map(Object.entries(kept).filter(([, at]) => Number.isFinite(at)));
    }

    /** @param {string} id */
    has(id) {
        return this.ids.has(id);
    }

    /** Whether to carry `command` out now. If so, it's remembered, so the
     * same one never passes again.
     * @param {Command} command @param {number} now ms */
    take(command, now) {
        for (const [id, at] of this.ids) if (now - at >= SEEN_KEPT_MS) this.ids.delete(id);
        if (!commandIsFresh(command, now, this)) return false;
        this.ids.set(command.id, now);
        return true;
    }

    /** What to keep. @returns {Record<string, number>} */
    kept() {
        return Object.fromEntries(this.ids);
    }
}

/** How long a `peek` asks for stills, in seconds: 30 with none said, kept
 * to between 1 and 35. @param {Command['command']} command */
export const peekSeconds = (command) => Math.min(Math.max(command.value ?? 30, 1), PEEK_MAX_SECONDS);
