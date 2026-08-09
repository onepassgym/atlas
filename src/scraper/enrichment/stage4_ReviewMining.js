'use strict';
/**
 * Stage 4 — Review Mining
 * Deep review aggregation from all available sources:
 * - Google Maps: 500-review deep scrape
 * - JustDial: scrape listing page reviews
 * - Yelp: API reviews (if key configured)
 *
 * Deduplicates by reviewId.
 */

const gmSource   = require('../sources/GoogleMapsSource');
const jdSource   = require('../sources/JustDialSource');
const yelpSource = require('../sources/YelpSource');
const logger     = require('../../utils/logger');

async function runStage4(space) {
  const allReviews   = [];
  const reviewIdSeen = new Set();

  // Collect reviews from all available sources concurrently
  const tasks = [];

  if (space.googleMapsUrl || space.crawl?.sourceUrl) {
    tasks.push(
      gmSource.enrichSpace(space, ['reviews'])
        .then(data => { addReviews(data?.reviews, allReviews, reviewIdSeen, 'google_maps'); })
        .catch(err => logger.warn(`[stage4] Google Maps reviews failed: ${err.message}`))
    );
  }

  const jdUrl = space.sources?.includes('justdial') ? space.crawl?.sourceUrl : null;
  if (jdUrl && jdSource.canHandleUrl(jdUrl)) {
    tasks.push(
      jdSource.scrapeByUrl(jdUrl)
        .then(data => { addReviews(data?.reviews, allReviews, reviewIdSeen, 'justdial'); })
        .catch(err => logger.warn(`[stage4] JustDial reviews failed: ${err.message}`))
    );
  }

  if (cfg_yelpEnabled() && space.totalReviews > 0) {
    tasks.push(
      yelpSource.enrichSpace(space, ['reviews'])
        .then(data => { addReviews(data?.reviews, allReviews, reviewIdSeen, 'yelp'); })
        .catch(err => logger.warn(`[stage4] Yelp reviews failed: ${err.message}`))
    );
  }

  await Promise.allSettled(tasks);

  return {
    _newReviews:    allReviews,
    _reviewSources: allReviews.length > 0
      ? [...new Set(allReviews.map(r => r._source || 'unknown'))]
      : [],
    _stageData: { newReviewCount: allReviews.length },
  };
}

function addReviews(reviews, target, seen, sourceId) {
  if (!Array.isArray(reviews)) return;
  for (const r of reviews) {
    const id = r.reviewId || r.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    target.push({ ...r, _source: sourceId });
  }
}

function cfg_yelpEnabled() {
  try {
    return !!(require('../../../config').sources?.yelpApiKey);
  } catch (_) {
    return false;
  }
}

module.exports = { runStage4 };
