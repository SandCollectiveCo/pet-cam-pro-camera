// The rule for every name the home's devices seal for each other (docs/
// API.md, Sealed messages, Names), which the page holds a name to again
// before it shows one: what opens is read as it is and shown held to the
// rule, since nothing else can check it. The page is handed two names and
// no others: the person who started the camera, in its pass, and what a
// calling device is called, in its `watch`.
//
// One line: a run of spaces, tabs, line breaks or control characters is one
// space, with none at either end. At most 60 characters as a person counts
// them (a letter with its accents, a flag or a family is one), by the
// browser's own rules for what a character is, and at most 240 bytes of
// UTF-8. A name is cut after the last whole character that fits both.
// The same as `NameRule` in the apps' Shared/, case for case.

export const NAME_MAX_CHARACTERS = 60;
export const NAME_MAX_BYTES = 240;

/** A character that only separates: white space, a line break, a control. */
const GAP = /^[\p{White_Space}\p{Cc}]/u;
/** A letter written right to left (Hebrew, Arabic and their neighbours), or a mark that turns text round. */
const TURNS = /[֐-ࣿיִ-﷿ﹰ-﻿؜‎‏‪-‮⁦-⁩]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

const encoder = new TextEncoder();
const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * A name held to the rule, or null where it wasn't text or nothing of it is left.
 * @param {unknown} raw @returns {string | null}
 */
export function cleanName(raw) {
    if (typeof raw !== 'string') return null;
    let kept = '';
    let count = 0;
    let bytes = 0;
    // A space is owed before the next character that's kept.
    let gap = false;
    for (const { segment } of characters.segment(raw)) {
        if (GAP.test(segment)) {
            gap = count > 0;
            continue;
        }
        const space = gap ? 1 : 0;
        const size = encoder.encode(segment).length;
        if (count + space + 1 > NAME_MAX_CHARACTERS || bytes + space + size > NAME_MAX_BYTES) break;
        kept += (gap ? ' ' : '') + segment;
        count += space + 1;
        bytes += space + size;
        gap = false;
    }
    return kept === '' ? null : kept;
}

/**
 * A name as it goes into a phrase the page writes around it ("… watching",
 * "… is borrowing this phone"). A line takes its direction from its first
 * strong letter, so a phrase that began with an Arabic or a Hebrew name
 * would be laid out right to left, the page's own words first. Between
 * Unicode's isolates a name keeps its own direction and lends the phrase
 * none, as the apps write one (`inPhrase`). A name with a mark that turns
 * text round gets them too, so the mark stops at the name's end.
 * @param {string} name
 */
export const inPhrase = (name) => (TURNS.test(name) ? `⁨${name}⁩` : name);
