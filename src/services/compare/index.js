'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Space comparison — turns raw Space documents into comparable records, finds
// the winner of each dimension, and picks an overall best with plain-language
// reasons. Pure functions only (no DB access), shared by
// GET /api/spaces/compare and GET /api/spaces/compare/suggest.
//
// Only dimensions that real Atlas data populates are compared. Pricing,
// highlights and offerings exist on the schema but are empty on nearly every
// record, so they're deliberately absent — a comparison row of "—" vs "—"
// tells a visitor nothing.
// ─────────────────────────────────────────────────────────────────────────────

const { haversineDistanceKm } = require('../../utils/geo');
const { categoryGroupForValue, compareFamilyForGroup } = require('../../utils/categoryGroups');
const { normalizeAmenities, AMENITY_FEATURES } = require('./amenities');
const { normalizeHours } = require('./hours');
const { normalizeBusyness } = require('./busyness');

// Bayesian prior: a space's rating is pulled toward PRIOR_MEAN with the weight
// of PRIOR_WEIGHT reviews, so 5.0★ from 3 reviews ranks below 4.8★ from 1,100.
const PRIOR_MEAN = 4.2;
const PRIOR_WEIGHT = 25;

const SCORE_WEIGHTS = {
  rating: 0.35,
  distance: 0.15,
  quality: 0.15,
  sentiment: 0.15,
  amenities: 0.1,
  hours: 0.1,
};

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const clamp01 = n => Math.max(0, Math.min(1, n));

function adjustedRating(rating, reviews) {
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const n = Math.max(0, reviews || 0);
  return (PRIOR_MEAN * PRIOR_WEIGHT + rating * n) / (PRIOR_WEIGHT + n);
}

const PIN_RE = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;

/**
 * The place's own pin (`!3d<lat>!4d<lng>` in the Maps URL) wins over the
 * stored lat/lng: a large share of records store the URL's `@lat,lng`
 * *viewport* centre instead (e.g. every Gurgaon gym scraped from a
 * Mumbai-centred search sits at 19.08,72.87), which would put a gym 1,100 km
 * from a visitor standing next to it.
 */
function spaceCoords(space) {
  const pin = typeof space.googleMapsUrl === 'string' ? space.googleMapsUrl.match(PIN_RE) : null;
  if (pin) {
    const lat = Number(pin[1]);
    const lng = Number(pin[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const lat = space.lat ?? space.location?.coordinates?.[1];
  const lng = space.lng ?? space.location?.coordinates?.[0];
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Builds the public comparison record for one space.
 * @param {object} space  lean Space doc (amenityIds + pageSlug populated)
 * @param {{lat:number,lng:number}|null} origin  visitor location, if shared
 */
function buildCompareRecord(space, origin) {
  const coords = spaceCoords(space);
  const distanceKm = origin && coords
    ? round(haversineDistanceKm(origin.lat, origin.lng, coords.lat, coords.lng), 2)
    : null;

  const rb = space.ratingBreakdown || {};
  const rbTotal = ['fiveStar', 'fourStar', 'threeStar', 'twoStar', 'oneStar'].reduce((s, k) => s + (rb[k] || 0), 0);
  const rating = Number.isFinite(space.rating) && space.rating > 0 ? space.rating : null;
  const totalReviews = space.totalReviews || 0;
  const amenities = normalizeAmenities(space);

  return {
    opgId: space.opgId,
    slug: space.pageSlug?.slug || space.slug || null,
    name: space.name,
    category: space.category || null,
    categoryGroup: categoryGroupForValue(space.category),
    categoryFamily: compareFamilyForGroup(categoryGroupForValue(space.category)),
    areaName: space.areaName || null,
    address: space.address || null,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    distanceKm,
    cover: space.coverPhoto?.publicUrl || space.coverPhoto?.thumbnailUrl || null,
    totalPhotos: space.totalPhotos || 0,
    googleMapsUrl: space.googleMapsUrl || null,
    contact: {
      phone: space.contact?.phone || null,
      website: space.contact?.website || null,
    },
    chainName: space.chainName || null,
    isVerified: !!space.atlas?.isVerified,
    isPartner: !!space.atlas?.isPartner,

    rating,
    totalReviews,
    adjustedRating: round(adjustedRating(rating, totalReviews), 2),
    ratingBreakdown: rbTotal > 0 ? rb : null,
    fiveStarShare: rbTotal > 0 ? round((rb.fiveStar || 0) / rbTotal, 3) : null,
    lowStarShare: rbTotal > 0 ? round(((rb.oneStar || 0) + (rb.twoStar || 0)) / rbTotal, 3) : null,

    qualityScore: Number.isFinite(space.qualityScore) ? space.qualityScore : null,
    scoreBreakdown: space.scoreBreakdown || null,
    // sentimentScore is -1..1 from review keywords; 0 with no tags means
    // "no signal" (no reviews analysed), not "neutral".
    sentiment: {
      score: totalReviews > 0 && Number.isFinite(space.sentimentScore) ? round(space.sentimentScore, 2) : null,
      positive: space.sentimentTags?.positive || [],
      negative: space.sentimentTags?.negative || [],
    },

    amenities: {
      known: amenities.known,
      keys: amenities.features.map(f => f.key),
      count: amenities.features.filter(f => f.benefit).length,
    },
    hours: normalizeHours(space.openingHours),
    busyness: normalizeBusyness(space),
    permanentlyClosed: !!space.permanentlyClosed,
    temporarilyClosed: !!space.temporarilyClosed,
  };
}

/**
 * 0–100 score from absolute (not relative) scales, so a space's score doesn't
 * change depending on what it's compared against — the same number ranks a
 * 3-way comparison and a 60-candidate "best near you" search. Weights of
 * dimensions with no data (e.g. distance with no visitor location) are
 * dropped and the rest re-normalised.
 */
function scoreRecord(record) {
  const parts = {
    rating: record.adjustedRating === null ? null : clamp01((record.adjustedRating - 3.5) / 1.5),
    distance: record.distanceKm === null ? null : 1 / (1 + record.distanceKm / 3),
    quality: record.qualityScore === null ? null : clamp01(record.qualityScore / 100),
    sentiment: record.sentiment.score === null ? null : clamp01((record.sentiment.score + 1) / 2),
    amenities: record.amenities.known ? clamp01(record.amenities.count / 8) : null,
    // 105h = 15h × 7 days — a typical full-service gym week.
    hours: record.hours.is24x7 ? 1 : record.hours.weeklyHours === null ? null : clamp01(record.hours.weeklyHours / 105),
  };

  let total = 0;
  let weight = 0;
  const breakdown = {};
  for (const [key, value] of Object.entries(parts)) {
    if (value === null) continue;
    total += SCORE_WEIGHTS[key] * value;
    weight += SCORE_WEIGHTS[key];
    breakdown[key] = Math.round(value * 100);
  }
  let score = weight > 0 ? Math.round((total / weight) * 100) : 0;
  if (record.permanentlyClosed) score = 0;
  return { score, breakdown };
}

// ── Dimensions ──────────────────────────────────────────────────────────────
// `better` decides the winner; `win` is the verdict sentence for the winner.
// `tolerance` is the smallest difference that counts: values within it of the
// best are tied, so a "Best" is never awarded on a gap the UI rounds away
// (94.4% vs 93.8% both display as "94%").
const fmtHour = h => {
  const hh = h % 24;
  const suffix = hh < 12 ? 'am' : 'pm';
  return `${hh % 12 === 0 ? 12 : hh % 12} ${suffix}`;
};

const DIMENSIONS = [
  {
    key: 'distance', label: 'Distance from you', better: 'lower', unit: 'km', tolerance: 0.05,
    get: r => r.distanceKm,
    win: (r) => `Closest to you (${r.distanceKm < 1 ? `${Math.round(r.distanceKm * 1000)} m` : `${r.distanceKm.toFixed(1)} km`})`,
  },
  {
    key: 'adjustedRating', label: 'Rating (review-weighted)', better: 'higher', tolerance: 0.02,
    get: r => r.adjustedRating,
    win: (r) => `Best review-weighted rating (${r.rating?.toFixed(1)}★ from ${r.totalReviews.toLocaleString('en-IN')} reviews)`,
  },
  {
    key: 'totalReviews', label: 'Number of reviews', better: 'higher',
    get: r => (r.totalReviews > 0 ? r.totalReviews : null),
    win: (r) => `Most reviewed (${r.totalReviews.toLocaleString('en-IN')} reviews)`,
  },
  {
    key: 'fiveStarShare', label: '5★ share of reviews', better: 'higher', unit: '%', tolerance: 0.01,
    get: r => r.fiveStarShare,
    win: (r) => `${Math.round(r.fiveStarShare * 100)}% of reviews are 5★`,
  },
  {
    key: 'lowStarShare', label: '1–2★ share of reviews', better: 'lower', unit: '%', tolerance: 0.01,
    get: r => r.lowStarShare,
    win: (r) => `Fewest bad reviews (${Math.round(r.lowStarShare * 100)}% at 1–2★)`,
  },
  {
    key: 'sentiment', label: 'Review sentiment', better: 'higher', tolerance: 0.05,
    get: r => r.sentiment.score,
    win: (r) => (r.sentiment.positive.length ? `Reviewers mention "${r.sentiment.positive.slice(0, 2).join('", "')}" most` : 'Most positive review sentiment'),
  },
  {
    key: 'qualityScore', label: 'Listing quality score', better: 'higher', tolerance: 1,
    get: r => r.qualityScore,
    win: (r) => `Most complete, up-to-date listing (${r.qualityScore}/100)`,
  },
  {
    key: 'amenities', label: 'Amenities listed', better: 'higher',
    get: r => (r.amenities.known ? r.amenities.count : null),
    win: (r) => `More amenities (${r.amenities.count} listed)`,
  },
  {
    key: 'weeklyHours', label: 'Open hours per week', better: 'higher', unit: 'h', tolerance: 1,
    get: r => (r.hours.is24x7 ? 168 : r.hours.weeklyHours),
    win: (r) => (r.hours.is24x7 ? 'Open 24/7' : `Longest opening hours (${Math.round(r.hours.weeklyHours)} h/week)`),
  },
  {
    key: 'earliestOpen', label: 'Opens earliest', better: 'lower',
    get: r => r.hours.earliestOpenMinutes,
    win: (r) => `Opens earliest (${fmtHour(Math.floor(r.hours.earliestOpenMinutes / 60))})`,
  },
  {
    key: 'latestClose', label: 'Closes latest', better: 'higher',
    get: r => r.hours.latestCloseMinutes,
    win: (r) => `Closes latest (${fmtHour(Math.floor(r.hours.latestCloseMinutes / 60))})`,
  },
  {
    key: 'peakBusyness', label: 'Crowd at peak time', better: 'lower', unit: '%', tolerance: 3,
    get: r => r.busyness.peakBusyness,
    win: (r) => `Less crowded at peak (${r.busyness.peakBusyness}% at ${fmtHour(r.busyness.peakHour)})`,
  },
  {
    key: 'totalPhotos', label: 'Photos', better: 'higher',
    get: r => (r.totalPhotos > 0 ? r.totalPhotos : null),
    win: () => 'Most photos to preview the space',
  },
];

// Verdict reasons are drawn from the best space's wins in this order — the
// things a visitor choosing a gym weighs first.
const REASON_PRIORITY = ['adjustedRating', 'distance', 'lowStarShare', 'weeklyHours', 'amenities', 'sentiment', 'peakBusyness', 'totalReviews', 'fiveStarShare', 'latestClose', 'earliestOpen', 'qualityScore', 'totalPhotos'];

function evaluateDimensions(records) {
  return DIMENSIONS.map(dim => {
    const values = records.map(r => ({ opgId: r.opgId, value: dim.get(r) }));
    const present = values.filter(v => v.value !== null && v.value !== undefined);
    let winners = [];
    // A winner needs at least two spaces with data and a real difference —
    // "tied on every value" or "only one space has this" crowns nobody.
    if (present.length >= 2) {
      const best = dim.better === 'lower'
        ? Math.min(...present.map(v => v.value))
        : Math.max(...present.map(v => v.value));
      const tol = dim.tolerance || 0;
      const winning = present.filter(v => Math.abs(v.value - best) <= tol);
      if (winning.length < present.length) winners = winning.map(v => v.opgId);
    }
    return {
      key: dim.key,
      label: dim.label,
      better: dim.better,
      unit: dim.unit || null,
      values,
      winners,
    };
  }).filter(d => d.values.some(v => v.value !== null && v.value !== undefined));
}

function buildVerdict(records, dimensions) {
  const ranking = records
    .map(r => ({ opgId: r.opgId, name: r.name, ...scoreRecord(r) }))
    .sort((a, b) => b.score - a.score);
  const best = ranking[0];
  const runnerUp = ranking[1];
  const bestRecord = records.find(r => r.opgId === best.opgId);

  const soleWins = new Set(dimensions.filter(d => d.winners.length === 1 && d.winners[0] === best.opgId).map(d => d.key));
  const reasons = REASON_PRIORITY
    .filter(k => soleWins.has(k))
    .slice(0, 4)
    .map(k => DIMENSIONS.find(d => d.key === k).win(bestRecord));

  // Where someone else is clearly better, say so — a verdict that hides the
  // trade-off reads like an ad.
  const tradeoffs = [];
  for (const key of ['distance', 'adjustedRating', 'weeklyHours']) {
    const dim = dimensions.find(d => d.key === key);
    if (!dim || dim.winners.length !== 1 || dim.winners[0] === best.opgId) continue;
    const other = records.find(r => r.opgId === dim.winners[0]);
    tradeoffs.push({ opgId: other.opgId, text: `${other.name}: ${DIMENSIONS.find(d => d.key === key).win(other)}` });
  }

  return {
    bestOpgId: best.opgId,
    closeCall: !!runnerUp && best.score - runnerUp.score < 3,
    reasons,
    tradeoffs,
    ranking,
  };
}

/** Per-feature presence across the compared spaces — only features at least one has. */
function buildAmenityMatrix(records) {
  return AMENITY_FEATURES
    .filter(f => records.some(r => r.amenities.keys.includes(f.key)))
    .map(f => ({
      key: f.key,
      label: f.label,
      group: f.group,
      benefit: f.benefit,
      // null = that space lists no amenities at all (unknown), not "doesn't have it".
      has: Object.fromEntries(records.map(r => [r.opgId, r.amenities.known ? r.amenities.keys.includes(f.key) : null])),
    }));
}

/**
 * Full comparison payload for 2–3 spaces.
 * @param {object[]} spaces  lean Space docs, in the order the caller asked for
 * @param {{lat:number,lng:number}|null} origin
 */
function compareSpaces(spaces, origin) {
  const records = spaces.map(s => buildCompareRecord(s, origin));
  const groups = [...new Set(records.map(r => r.categoryGroup))];
  const families = [...new Set(groups.map(compareFamilyForGroup))];
  const dimensions = evaluateDimensions(records);
  return {
    categoryGroup: groups.length === 1 ? groups[0] : null,
    categoryFamily: families.length === 1 ? families[0] : null,
    // Gym vs fitness centre is one family and not "mixed"; gym vs yoga is.
    mixedCategories: families.length > 1,
    origin: origin || null,
    spaces: records,
    dimensions,
    amenityMatrix: buildAmenityMatrix(records),
    verdict: buildVerdict(records, dimensions),
  };
}

/** Ranks candidate spaces for "best near you" — highest score first. */
function rankCandidates(spaces, origin) {
  return spaces
    .map(s => buildCompareRecord(s, origin))
    .filter(r => !r.permanentlyClosed && !r.temporarilyClosed)
    .map(r => ({ ...r, compare: scoreRecord(r) }))
    .sort((a, b) => b.compare.score - a.compare.score || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

module.exports = {
  PRIOR_MEAN,
  PRIOR_WEIGHT,
  SCORE_WEIGHTS,
  adjustedRating,
  buildCompareRecord,
  scoreRecord,
  compareSpaces,
  rankCandidates,
};
