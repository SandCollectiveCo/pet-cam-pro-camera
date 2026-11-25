// The rule for names (docs/API.md, Sealed messages, Names), which the page
// holds each name it's handed to before it shows one. No vector pins the
// rule: these are the apps' own cases for it (SharedTests/NameRuleTests),
// one for one, so the page and the apps cut a name the same way.

import { NAME_MAX_BYTES, NAME_MAX_CHARACTERS, cleanName, inPhrase } from '../src/names.js';
import { WORDS } from '../src/words.js';
import { assert, suite, test } from './lib/harness.js';

const bytes = (text) => new TextEncoder().encode(text).length;
const characters = (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

suite('names');

test('a name is one line with nothing at its ends', () => {
    assert.equal(cleanName('  Kitchen   iPad \n'), 'Kitchen iPad');
    assert.equal(cleanName('Hall\tphone\r\nupstairs'), 'Hall phone upstairs');
    // A no-break space and a line separator are spaces too.
    assert.equal(cleanName('Hall phone upstairs'), 'Hall phone upstairs');
    // Control characters.
    assert.equal(cleanName('\u0007Hall\u0000\u001Bphone\u007F'), 'Hall phone');
    for (const nothing of ['', '   ', '\n\t', '\u0000\u0007', ' ']) assert.equal(cleanName(nothing), null, JSON.stringify(nothing));
    // What isn't text is no name.
    for (const nothing of [undefined, null, 7, true, ['Kitchen iPad'], { name: 'Kitchen iPad' }]) assert.equal(cleanName(nothing), null);
});

test('a name keeps sixty characters as a person counts them', () => {
    assert.equal([NAME_MAX_CHARACTERS, NAME_MAX_BYTES], [60, 240]);
    assert.equal(characters(cleanName('a'.repeat(200))), 60);
    assert.equal(characters(cleanName('王'.repeat(200))), 60);
    // A letter with its accent written apart is one, and stays whole.
    const accented = cleanName('é'.repeat(200));
    assert.equal([characters(accented), [...accented].length], [60, 120]);
    // Sixty of four bytes each: exactly both limits.
    const foxes = cleanName('🦊'.repeat(200));
    assert.equal([characters(foxes), bytes(foxes)], [60, 240]);
    // At the limit it stays as it is, and one more is cut.
    const sixty = `${'ab '.repeat(19)}abc`;
    assert.equal(characters(sixty), 60);
    assert.equal(cleanName(sixty), sixty);
    assert.equal(cleanName(`${sixty}d`), sixty);
    // Never cut to end on a space.
    assert.equal(cleanName(`${'a'.repeat(59)} b`), 'a'.repeat(59));
    assert.equal(cleanName(`${'a'.repeat(58)} b`), `${'a'.repeat(58)} b`);
});

test('a name keeps 240 bytes in whole characters', () => {
    // A family is seven code points and 25 bytes; a flag two and eight.
    const family = '👨‍👩‍👧‍👦';
    assert.equal([characters(family), bytes(family)], [1, 25]);
    assert.equal(cleanName(family.repeat(60)), family.repeat(9));
    assert.equal(cleanName('🇵🇱'.repeat(60)), '🇵🇱'.repeat(30));
    // One character too big for a name by itself leaves nothing.
    const stacked = `a${'́'.repeat(200)}`;
    assert.equal(characters(stacked), 1);
    assert.equal(cleanName(stacked), null);
    assert.equal(cleanName(`Hall ${stacked}`), 'Hall');
});

test('a name inside a phrase keeps its own direction and lends the phrase none', () => {
    assert.equal(inPhrase('Maya Lopez'), 'Maya Lopez');
    assert.equal(inPhrase('王秀英'), '王秀英');
    // Arabic and Hebrew names go between Unicode's isolates, as the apps write them.
    assert.equal(inPhrase('نور الهدى'), '⁨نور الهدى⁩');
    assert.equal(inPhrase('דנה'), '⁨דנה⁩');
    // So does a name carrying a mark that turns text round, which then stops at the name's end.
    assert.equal(inPhrase('‮enohp'), '⁨‮enohp⁩');
    assert.equal(WORDS.watching(['نور الهدى', '王秀英']), '⁨نور الهدى⁩ and 王秀英 watching');
    assert.equal(WORDS.whose('نور'), '⁨نور⁩’s camera');
});

test('the page has words for a camera whose pass named nobody', () => {
    const now = new Date(2026, 10, 24, 14, 10, 0).getTime();
    const named = WORDS.borrowing('Maya Lopez', 'phone', now + 86_400_000, now);
    assert.ok(/^Maya Lopez is borrowing this phone as a camera until tomorrow, /.test(named), named);
    const unnamed = WORDS.borrowing(null, 'phone', now + 86_400_000, now);
    assert.ok(/^This phone is being borrowed as a camera until tomorrow, /.test(unnamed), unnamed);
    assert.equal([WORDS.whose('Maya Lopez'), WORDS.whose(null)], ['Maya Lopez’s camera', 'Temporary camera']);
});
