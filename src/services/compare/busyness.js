'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Popular-times ("how busy") summary for comparison.
//
// Two shapes exist on Space:
//   • operationalData.popularTimesData — structured [{ day, hours:[{hour,busyness}] }]
//     from the enrichment scraper (preferred; rarely populated so far).
//   • popularTimes — raw aria-label strings from the Maps panel, e.g.
//     "91% busy at 7 pm.", one per bar, all days concatenated with no day
//     label. A new day starts whenever the hour stops increasing.
// Days aren't reliably labelled in the raw form, so the summary is
// day-agnostic: the average weekly curve, its peak, and its quiet hours.
// ─────────────────────────────────────────────────────────────────────────────

const QUIET_THRESHOLD = 35; // % — at or below this reads as "quiet"

function parseRawBars(raw) {
  const blocks = [];
  let current = null;
  let lastHour = -1;
  for (const label of Array.isArray(raw) ? raw : []) {
    if (typeof label !== 'string') continue;
    const m = label.replace(/[   ]/g, ' ').match(/(\d{1,3})%\s*busy at\s*(\d{1,2})(?::\d{2})?\s*(am|pm)/i);
    if (!m) continue;
    let hour = parseInt(m[2], 10);
    const ampm = m[3].toLowerCase();
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!current || hour <= lastHour) {
      current = [];
      blocks.push(current);
    }
    current.push({ hour, busyness: Math.min(100, parseInt(m[1], 10)) });
    lastHour = hour;
  }
  return blocks;
}

function structuredBlocks(space) {
  const data = space.operationalData?.popularTimesData;
  if (!Array.isArray(data) || data.length === 0) return [];
  return data
    .map(d => (Array.isArray(d.hours) ? d.hours : []).filter(h => Number.isFinite(h.hour) && Number.isFinite(h.busyness)))
    .filter(b => b.length > 0);
}

/**
 * @returns {{ known: boolean, peakHour: number|null, peakBusyness: number|null,
 *   quietHours: number[], hourly: Array<{hour:number,busyness:number}> }}
 *   `hourly` averages each hour over the days that report it, skipping hours
 *   that read 0% on every day (closed, not "empty").
 */
function normalizeBusyness(space) {
  let blocks = structuredBlocks(space);
  if (blocks.length === 0) blocks = parseRawBars(space.popularTimes);
  if (blocks.length === 0) return { known: false, peakHour: null, peakBusyness: null, quietHours: [], hourly: [] };

  const sums = new Map();
  for (const block of blocks) {
    for (const { hour, busyness } of block) {
      const s = sums.get(hour) || { total: 0, n: 0, max: 0 };
      s.total += busyness;
      s.n += 1;
      s.max = Math.max(s.max, busyness);
      sums.set(hour, s);
    }
  }

  const hourly = [...sums.entries()]
    .filter(([, s]) => s.max > 0)
    .sort(([a], [b]) => a - b)
    .map(([hour, s]) => ({ hour, busyness: Math.round(s.total / s.n) }));

  if (hourly.length === 0) return { known: false, peakHour: null, peakBusyness: null, quietHours: [], hourly: [] };

  const peak = hourly.reduce((a, b) => (b.busyness > a.busyness ? b : a));
  return {
    known: true,
    peakHour: peak.hour,
    peakBusyness: peak.busyness,
    quietHours: hourly.filter(h => h.busyness > 0 && h.busyness <= QUIET_THRESHOLD).map(h => h.hour),
    hourly,
  };
}

module.exports = { normalizeBusyness };
