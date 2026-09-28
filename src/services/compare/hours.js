'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Opening-hours parsing for comparison.
//
// `Space.openingHours[].open/close` are the raw Google Maps strings, with a
// narrow no-break space before am/pm ("6 am"), holiday notes glued onto
// the day ("Wednesday(Haryana Heroes’ Martyrdom Day)") and on the close
// ("12 am Hours might differ"). Split shifts ("6 am–12 pm, 5–11 pm") were
// flattened by the scraper into open "6 am" / close "12 pm5" — the second
// shift's close is lost. Those days are marked `approximate` and left out of
// every total rather than guessed, so a split-shift gym is never credited
// with hours it may not keep.
// ─────────────────────────────────────────────────────────────────────────────

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MIN_PER_DAY = 24 * 60;

function cleanText(s) {
  return String(s ?? '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDay(raw) {
  const word = cleanText(raw).split(/[\s(]/)[0].toLowerCase();
  return DAYS.find(d => d.toLowerCase() === word || d.toLowerCase().startsWith(word.slice(0, 3))) || null;
}

/**
 * Parses "6 am" / "5:30 pm" / "12 am" into minutes after midnight.
 * @returns {{ minutes: number, clean: boolean } | null} `clean` is false when
 *   the string had no am/pm or trailing garbage (e.g. "12 pm5").
 */
function parseClock(raw) {
  const s = cleanText(raw).toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (hour > 24 || min > 59) return null;
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const rest = s.slice(m[0].length).trim();
  // "hours might differ" is a holiday caveat, not a malformed time.
  const clean = !!ampm && (rest === '' || /^hours might differ/.test(rest));
  return { minutes: hour * 60 + min, clean };
}

function fmt(minutes) {
  const m = ((minutes % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function parseDay(entry) {
  const day = normalizeDay(entry.day);
  if (!day) return null;
  const openRaw = cleanText(entry.open);

  if (entry.isOpen24 || /open 24 hours/i.test(openRaw)) {
    return { day, is24: true, closed: false, approximate: false, open: '00:00', close: '24:00', minutes: MIN_PER_DAY };
  }
  if (entry.isClosed || /^closed$/i.test(openRaw)) {
    return { day, is24: false, closed: true, approximate: false, open: null, close: null, minutes: 0 };
  }

  const open = parseClock(entry.open);
  const close = parseClock(entry.close);
  if (!open || !close) {
    return { day, is24: false, closed: false, approximate: true, open: null, close: null, minutes: null };
  }

  // Close at/before open means the space closes after midnight ("6 am – 12 am").
  let closeMin = close.minutes;
  if (closeMin <= open.minutes) closeMin += MIN_PER_DAY;
  const approximate = !open.clean || !close.clean;

  return {
    day,
    is24: false,
    closed: false,
    approximate,
    open: fmt(open.minutes),
    close: closeMin === MIN_PER_DAY ? '24:00' : fmt(closeMin),
    openMinutes: open.minutes,
    closeMinutes: closeMin,
    minutes: approximate ? null : closeMin - open.minutes,
  };
}

/**
 * @returns {{
 *   known: boolean, approximate: boolean, days: object[],
 *   daysOpen: number|null, weeklyHours: number|null, is24x7: boolean,
 *   earliestOpen: string|null, latestClose: string|null,
 *   earliestOpenMinutes: number|null, latestCloseMinutes: number|null,
 * }}
 * Totals are computed only from cleanly-parsed days; `weeklyHours` is null
 * unless all 7 days parsed cleanly, since a partial sum would under-report.
 */
function normalizeHours(openingHours) {
  const byDay = new Map();
  for (const entry of Array.isArray(openingHours) ? openingHours : []) {
    const parsed = entry && parseDay(entry);
    if (parsed && !byDay.has(parsed.day)) byDay.set(parsed.day, parsed);
  }
  const days = DAYS.filter(d => byDay.has(d)).map(d => byDay.get(d));

  if (days.length === 0) {
    return {
      known: false, approximate: false, days: [], daysOpen: null, weeklyHours: null, is24x7: false,
      earliestOpen: null, latestClose: null, earliestOpenMinutes: null, latestCloseMinutes: null,
    };
  }

  const approximate = days.length < 7 || days.some(d => d.approximate);
  const cleanOpenDays = days.filter(d => !d.closed && !d.approximate);
  const timedDays = cleanOpenDays.filter(d => !d.is24);
  const is24x7 = days.length === 7 && days.every(d => d.is24);

  const earliestOpenMinutes = is24x7 ? 0
    : timedDays.length ? Math.min(...timedDays.map(d => d.openMinutes)) : (cleanOpenDays.length ? 0 : null);
  const latestCloseMinutes = is24x7 ? MIN_PER_DAY
    : timedDays.length ? Math.max(...timedDays.map(d => d.closeMinutes)) : (cleanOpenDays.length ? MIN_PER_DAY : null);

  const weeklyMinutes = approximate ? null : days.reduce((sum, d) => sum + d.minutes, 0);

  return {
    known: true,
    approximate,
    days: days.map(({ openMinutes, closeMinutes, minutes, ...rest }) => rest),
    daysOpen: approximate ? null : days.filter(d => !d.closed).length,
    weeklyHours: weeklyMinutes === null ? null : Math.round((weeklyMinutes / 60) * 10) / 10,
    is24x7,
    earliestOpen: earliestOpenMinutes === null ? null : fmt(earliestOpenMinutes),
    // Past-midnight closes read "01:00+1" so they still sort after "23:00".
    latestClose: latestCloseMinutes === null ? null
      : latestCloseMinutes === MIN_PER_DAY ? '24:00'
      : latestCloseMinutes > MIN_PER_DAY ? `${fmt(latestCloseMinutes)}+1`
      : fmt(latestCloseMinutes),
    earliestOpenMinutes,
    latestCloseMinutes,
  };
}

module.exports = { normalizeHours, parseClock };
