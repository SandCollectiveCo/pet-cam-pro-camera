// When a camera ends, as the apps and the page say it: "until tomorrow,
// 2:10 PM" (docs/WEB-CAMERA.md § 1).

const DAY_MS = 86_400_000;

/** @param {Date} date */
const dayOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * @param {number} endsAt ms
 * @param {number} now ms
 * @param {{ hourCycle?: 'h12' | 'h23', timeZone?: string }} [how] the device's own way of writing a time, unless a test says
 * @returns {string} "until today, 9:40 PM", "until tomorrow, 2:10 PM", "until Friday, 2:10 PM", "until Nov 30, 2:10 PM"
 */
export function until(endsAt, now, how = {}) {
    const end = new Date(endsAt);
    const hourCycle = how.hourCycle ?? (new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h2') ? 'h23' : 'h12');
    const zone = how.timeZone ? { timeZone: how.timeZone } : {};
    // Some systems put a narrow space before "PM": a plain one reads the same everywhere.
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle, ...zone }).format(end).replace(/[  ]/g, ' ');
    // Whole days between the two, by the calendar where the device is (or the test's zone).
    const local = (date) => (how.timeZone ? new Date(date.toLocaleString('en-US', { timeZone: how.timeZone })) : date);
    const days = Math.round((dayOf(local(end)) - dayOf(local(new Date(now)))) / DAY_MS);
    let day;
    if (days <= 0) day = 'today';
    else if (days === 1) day = 'tomorrow';
    else if (days < 7) day = new Intl.DateTimeFormat('en-US', { weekday: 'long', ...zone }).format(end);
    else day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...zone }).format(end);
    return `until ${day}, ${time}`;
}

/** The time of day for the faint clock: "2:10" or "14:10", as the device writes it. @param {number} now ms */
export function clockTime(now) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(now)).replace(/[  ]/g, ' ').replace(/\s?[AP]M$/i, '');
}
