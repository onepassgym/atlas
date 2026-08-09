'use strict';

// ── Thresholds ────────────────────────────────────────────────────────────────
const PUBLISH_THRESHOLD     = 60;
const HIGH_QUALITY_THRESHOLD= 80;
const STALENESS_HALF_LIFE_DAYS = 90;

/**
 * Calculates a composite 0-100 quality score.
 * Works for both raw crawl format (lat/lng/photos/category) and v5 Space documents.
 *
 * Dimensions (100 pts total):
 *   rating          30 pts  — (rating / 5) × 30
 *   reviewDensity   15 pts  — log-scale, caps at 500 reviews
 *   completeness    20 pts  — 12 field checks
 *   sourceConfidence20 pts  — avg(fieldConfidence.values()) or half-credit default
 *   staleness       15 pts  — exponential decay, half-life 90 days
 *
 * @param {Object} gymData
 * @returns {{ score: number, breakdown: Object }}
 */
function calculateQualityScore(gymData) {
  const breakdown = {
    rating:          0,
    reviewDensity:   0,
    completeness:    0,
    sourceConfidence:0,
    staleness:       0,
  };

  // 1. Rating (30 pts)
  if ((gymData.rating || 0) > 0) {
    breakdown.rating = Math.round((gymData.rating / 5) * 30);
  }

  // 2. Review density (15 pts, log-scale capped at 500)
  const totalReviews = gymData.totalReviews || 0;
  if (totalReviews > 0) {
    breakdown.reviewDensity = Math.round(Math.min((Math.log(totalReviews + 1) / Math.log(501)) * 15, 15));
  }

  // 3. Completeness (20 pts, 12 field checks)
  // Handles both raw crawl format (lat/lng/photos/category) and Space document format.
  const checks = [
    gymData.name,
    gymData.lat != null || gymData.location?.coordinates?.length >= 2,
    gymData.address,
    gymData.contact?.phone,
    gymData.contact?.website,
    (gymData.rating || 0) > 0,
    (gymData.totalReviews || 0) > 0,
    (gymData.openingHours?.length || 0) > 0,
    (gymData.rawPhotoUrls?.length || gymData.photos?.length || gymData.totalPhotos || 0) > 0 || !!gymData.coverUrl,
    gymData.description,
    gymData.primaryCategorySlug || gymData.category || gymData.categoryId || (gymData.categorySlugs?.length || 0) > 0,
    (gymData.amenitySlugs?.length || gymData.amenities?.length || 0) > 0,
  ];
  const filled = checks.filter(Boolean).length;
  breakdown.completeness = Math.round((filled / checks.length) * 20);

  // 4. Source confidence (20 pts)
  // Uses fieldConfidence Map if present, otherwise awards half-credit (10 pts)
  const fc = gymData.fieldConfidence;
  if (fc && (fc instanceof Map ? fc.size : Object.keys(fc).length) > 0) {
    const values = fc instanceof Map ? [...fc.values()] : Object.values(fc);
    const confidences = values.map(v => (typeof v === 'object' ? (v.confidence || 0) : v)).filter(c => typeof c === 'number');
    const avg = confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : 0.5;
    breakdown.sourceConfidence = Math.round(avg * 20);
  } else {
    breakdown.sourceConfidence = 10; // half-credit when no confidence data available
  }

  // 5. Staleness (15 pts, exponential decay, half-life 90 days)
  const lastCrawledAt = gymData.crawl?.lastCrawledAt || gymData.crawlMeta?.lastCrawledAt || null;
  if (lastCrawledAt) {
    const daysSince = (Date.now() - new Date(lastCrawledAt).getTime()) / 86_400_000;
    breakdown.staleness = Math.round(15 * Math.exp(-daysSince / STALENESS_HALF_LIFE_DAYS));
  } else {
    breakdown.staleness = 15; // assume fresh if just crawled
  }

  const score = Math.min(100, Math.max(0,
    breakdown.rating + breakdown.reviewDensity + breakdown.completeness +
    breakdown.sourceConfidence + breakdown.staleness,
  ));

  return { score, breakdown };
}

module.exports = { calculateQualityScore, PUBLISH_THRESHOLD, HIGH_QUALITY_THRESHOLD };

