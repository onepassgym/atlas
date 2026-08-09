'use strict';
/**
 * processDiscoveryCandidates — Phase 7A
 * Takes candidates from discoveryService (OSM + JustDial + Maps)
 * and runs each through entityResolver → validationService → upsertSpace.
 *
 * Called by runSeedBasedCrawl after discoveryService.discover().
 * Non-blocking per-candidate: errors are counted but never throw.
 */

const { resolveEntity }       = require('./entityResolver');
const { validateCandidate }   = require('./validationService');
const { upsertSpace }         = require('../db/upsertSpace');
const { ingest }              = require('./rawIngestionService');
const CrawlRun                = require('../db/crawlRunModel');
const logger                  = require('../utils/logger');

/**
 * @param {RawSpaceResult[]} candidates
 * @param {string}           cityOpgId
 * @param {ObjectId}         crawlRunId
 * @returns {{ created, updated, skipped, needsReview, errors }}
 */
async function processDiscoveryCandidates(candidates, cityOpgId, crawlRunId) {
  const stats = { created: 0, updated: 0, skipped: 0, needsReview: 0, errors: 0 };

  for (const candidate of candidates) {
    try {
      // 1. Persist raw payload (crash safety)
      await ingest(
        candidate.sourceId || 'osm',
        candidate.placeId || candidate.sourceEntityId || String(Math.random()),
        candidate,
        crawlRunId,
        cityOpgId
      ).catch(() => {});

      // 2. Validate before touching the DB
      const validation = await validateCandidate(candidate, cityOpgId);
      if (!validation.valid) {
        if (validation.needsReview) stats.needsReview++;
        else stats.errors++;
        continue;
      }

      // 3. Entity resolution — determine if new, merge, or ambiguous
      const resolution = await resolveEntity(candidate, cityOpgId);

      if (resolution.action === 'needsReview') {
        stats.needsReview++;
        continue; // NeedsReview doc already created inside resolveEntity
      }

      // 4. Build Space-compatible doc from RawSpaceResult
      const doc = _toSpaceDoc(candidate, resolution, cityOpgId);

      // 5. Upsert into spaces collection
      const result = await upsertSpace(doc);

      if (result.action === 'created')      stats.created++;
      else if (result.action === 'updated') stats.updated++;
      else                                   stats.skipped++;

    } catch (err) {
      stats.errors++;
      logger.warn(`[DiscoveryProcessor] Failed for "${candidate?.name}": ${err.message}`);
    }
  }

  // Update crawl_run counters
  if (crawlRunId) {
    await CrawlRun.updateOne({ _id: crawlRunId }, {
      $inc: {
        recordsNew:         stats.created,
        recordsUpdated:     stats.updated,
        recordsDropped:     stats.errors,
        recordsNeedsReview: stats.needsReview,
      },
    }).catch(() => {});
  }

  return stats;
}

/** Map RawSpaceResult fields to the shape upsertSpace() expects. */
function _toSpaceDoc(r, resolution, cityOpgId) {
  const coords = r.location?.coordinates || (r.lng && r.lat ? [r.lng, r.lat] : null);
  return {
    placeId:       r.placeId       || null,
    googleMapsUrl: r.googleMapsUrl || null,
    name:          r.name,
    lat:           coords ? coords[1] : (r.lat || null),
    lng:           coords ? coords[0] : (r.lng || null),
    address:       r.address       || null,
    city:          r.city          || r.location?.city || null,
    areaName:      r.areaName      || r.location?.area || null,
    contact: {
      phone:   r.contact?.phone   || r.phone   || null,
      website: r.contact?.website || r.website || null,
      email:   r.contact?.email   || r.email   || null,
    },
    rating:        r.rating        || null,
    totalReviews:  r.totalReviews  || 0,
    description:   r.description   || null,
    category:      r.primaryCategorySlug || (r.categories?.[0]) || null,
    categories:    r.categorySlugs || r.categories || [],
    openingHours:  r.openingHours  || [],
    rawPhotoUrls:  r.photos        || r.rawPhotoUrls || [],
    amenities:     r.amenities     || {},
    sources:       [r.sourceId].filter(Boolean),
    createdVia:    'discovery-pipeline',
    // Pass through cityOpgId if already resolved
    cityOpgId:     cityOpgId       || null,
    // Tag with existing entityOpgId if this is a merge
    _resolvedOpgId: resolution.action === 'merge' ? resolution.entityOpgId : null,
  };
}

module.exports = { processDiscoveryCandidates };
