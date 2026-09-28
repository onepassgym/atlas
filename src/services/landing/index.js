'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Category × city landing facts (opg-web's /c/:category/:city pages).
//
// Turns the spaces matching one category family in one city into the live
// numbers and lists those SEO pages render — counts, average rating, review
// volume, 24/7 and early/late coverage, popular localities, common amenities,
// top picks — so the page stops shipping hand-typed figures. Pure functions:
// the route does the querying. Hours, amenities and scoring reuse
// services/compare, so "open 24/7" or "top pick" means the same thing on the
// landing page, in a comparison and in the finder.
// ─────────────────────────────────────────────────────────────────────────────

const { rankCandidates } = require('../compare');
const { AMENITY_FEATURES } = require('../compare/amenities');

const EARLY_OPEN_MIN = 5 * 60 + 30;  // opens by 5:30 am
const LATE_CLOSE_MIN = 23 * 60;      // closes at 11 pm or later

// Address segments that are a unit/building, not a neighbourhood.
const NOT_A_LOCALITY = /\b(floor|shop|plot|sco|scf|tower|building|bldg|near|opp|opposite|behind|above|below|basement|no\.?|house|flat|unit|complex|plaza|mall|market|road no)\b|^\d/i;

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

/**
 * The neighbourhood from a Google-format address: the segment just before the
 * city ("…, Block C, Sushant Lok Phase I, Sector 43, Gurugram, Haryana 122003"
 * → "Sector 43"). `null` when the address has no usable segment there.
 */
function localityFromAddress(address, cityVariants) {
  if (!address) return null;
  const parts = String(address).split(',').map(p => p.trim()).filter(Boolean);
  const variants = cityVariants.map(v => v.replace(/-/g, ' '));
  let cityIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i].toLowerCase().replace(/\s+\d{6}$/, '');
    if (variants.some(v => seg === v || seg.endsWith(` ${v}`))) { cityIdx = i; break; }
  }
  // "…, Paharganj, New Delhi, Delhi 110055": step back over every segment
  // that is itself a spelling of the city before taking the locality.
  const isCity = seg => { const s = seg.toLowerCase(); return variants.some(v => s === v || s.endsWith(` ${v}`)); };
  let idx = cityIdx - 1;
  while (idx >= 0 && isCity(parts[idx])) idx--;
  if (idx < 0) return null;
  const raw = parts[idx].replace(/\s+/g, ' ');
  if (raw.length < 3 || raw.length > 40 || NOT_A_LOCALITY.test(raw)) return null;
  // "Sec-43" / "sector-43" / "Sector 43" → one spelling.
  const normalized = raw.replace(/^sec(?:tor)?[\s.-]*(\d+[a-z]?)$/i, 'Sector $1');
  return titleCase(normalized)
    .replace(/\bDlf\b/g, 'DLF')
    .replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix)\b/g, m => m.toUpperCase());
}

function slim(record) {
  return {
    opgId: record.opgId,
    slug: record.slug,
    name: record.name,
    rating: record.rating,
    totalReviews: record.totalReviews,
    score: record.compare?.score ?? null,
    cover: record.cover,
    areaName: record.areaName,
  };
}

/**
 * @param {object[]} spaces   lean Space docs (compare fields) for the category × city
 * @param {object}   opts     { total, cityVariants }
 */
function summarizeLanding(spaces, { total, cityVariants }) {
  const ranked = rankCandidates(spaces, null);
  const rated = ranked.filter(r => r.rating !== null && r.totalReviews > 0);

  const areaCounts = new Map();
  for (const s of spaces) {
    const loc = localityFromAddress(s.address, cityVariants);
    if (loc) areaCounts.set(loc, (areaCounts.get(loc) || 0) + 1);
  }

  const withAmenities = ranked.filter(r => r.amenities.known);
  const amenityCounts = new Map();
  for (const r of withAmenities) for (const key of r.amenities.keys) amenityCounts.set(key, (amenityCounts.get(key) || 0) + 1);

  const open24 = ranked.filter(r => r.hours.is24x7);
  const early = ranked.filter(r => !r.hours.is24x7 && r.hours.earliestOpenMinutes !== null && r.hours.earliestOpenMinutes <= EARLY_OPEN_MIN);
  const late = ranked.filter(r => !r.hours.is24x7 && r.hours.latestCloseMinutes !== null && r.hours.latestCloseMinutes >= LATE_CLOSE_MIN);

  const round1 = n => Math.round(n * 10) / 10;

  return {
    total,
    analysed: spaces.length,
    ratedCount: rated.length,
    avgRating: rated.length ? round1(rated.reduce((s, r) => s + r.rating, 0) / rated.length) : null,
    totalReviews: ranked.reduce((s, r) => s + (r.totalReviews || 0), 0),
    highlyRatedCount: rated.filter(r => r.rating >= 4.5 && r.totalReviews >= 20).length,
    partnerCount: ranked.filter(r => r.isPartner).length,
    open24x7Count: open24.length,
    earlyOpenCount: early.length,
    lateCloseCount: late.length,
    // Localities need ≥2 spaces to be a real "area", not one address's quirk.
    topAreas: [...areaCounts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, count]) => ({ name, count })),
    amenitiesKnownCount: withAmenities.length,
    topAmenities: AMENITY_FEATURES
      .filter(f => f.benefit && amenityCounts.get(f.key))
      .map(f => ({ key: f.key, label: f.label, count: amenityCounts.get(f.key), share: Math.round((amenityCounts.get(f.key) / withAmenities.length) * 100) / 100 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    topPicks: ranked.filter(r => r.totalReviews >= 20).slice(0, 3).map(slim),
    open24x7: open24.slice(0, 3).map(slim),
  };
}

// A quoted review has to be about training there. Google files clubs,
// gymkhanas and hotels with gyms under "gym", and their reviews are about
// weddings and food — true, but useless (and odd) on a gyms page.
const FITNESS_TERMS = /\b(gym|workout|work out|train(er|ers|ing)?|coach|equipment|machines?|weights?|dumbbells?|cardio|treadmill|fitness|exercise|classes?|instructor|yoga|pilates|swim(ming)?|pool|crossfit|strength|membership|zumba|dance|boxing|mma)\b/i;

/** Keeps reviews worth quoting: 4★+, substantive, about fitness, at most one per space. */
function pickReviews(reviews, spacesByOpgId, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const r of reviews) {
    const text = (r.text || '').trim();
    if (!r.opgId || seen.has(r.opgId) || text.length < 80 || text.length > 600 || !FITNESS_TERMS.test(text)) continue;
    const space = spacesByOpgId.get(r.opgId);
    if (!space) continue;
    seen.add(r.opgId);
    out.push({
      authorName: r.authorName || 'Google reviewer',
      authorAvatar: r.authorAvatar || null,
      rating: r.rating,
      text,
      publishedAt: r.publishedAt || null,
      publishedAtRaw: r.publishedAtRaw || null,
      space: { opgId: space.opgId, name: space.name, slug: space.pageSlug?.slug || space.slug || null },
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { localityFromAddress, summarizeLanding, pickReviews };
