'use strict';
/**
 * ensureIndexes.js
 *
 * Consolidates ALL index creation across every collection.
 * Called once after MongoDB connects.
 * Uses the native MongoDB driver (mongoose.connection.db) so that we can
 * pass the full options object without Mongoose interfering.
 */
const mongoose = require('mongoose');
const logger   = require('../utils/logger');
const cfg = require('../../config');

async function ensureIndexes() {
  const db = mongoose.connection.db;
  const c = cfg.collections;

  // ── spaces ────────────────────────────────────────────────────────────────
  const spaces = db.collection(c.spaces);
  await spaces.createIndex({ slug: 1 },           { unique: true, sparse: true, name: 'slug_unique' });
  await spaces.createIndex({ googleMapsUrl: 1 },  { name: 'googleMapsUrl_1' });
  await spaces.createIndex({ placeId: 1 },        { sparse: true, name: 'placeId_sparse' });
  await spaces.createIndex({ location: '2dsphere' }, { sparse: true, name: 'location_2dsphere' });
  // Dedup tier 5: phone lookup — avoids COLLSCAN on regex phone match
  await spaces.createIndex({ 'contact.phone': 1 }, { sparse: true, name: 'contact_phone_sparse' });
  // Suggestions / filter indexes — avoids COLLSCAN on areaName and chainName
  await spaces.createIndex({ areaName: 1 },        { name: 'areaName_1' });
  await spaces.createIndex({ chainName: 1 },       { sparse: true, name: 'chainName_sparse' });
  await spaces.createIndex({ primaryCategorySlug: 1 }, { name: 'primaryCategorySlug_1' });
  await spaces.createIndex({ areaName: 1, primaryCategorySlug: 1 }, { name: 'areaName_primaryCategorySlug' });

  // ── space_reviews ─────────────────────────────────────────────────────────
  const reviews = db.collection(c.spaceReviews);
  await reviews.createIndex({ spaceId: 1 },    { name: 'reviews_spaceId' });
  await reviews.createIndex({ reviewId: 1 }, { unique: true, name: 'reviewId_unique' });

  // ── space_change_logs ─────────────────────────────────────────────────────
  const logs = db.collection(c.spaceChangeLogs);
  await logs.createIndex({ spaceId: 1 },    { name: 'changeLogs_spaceId' });
  await logs.createIndex({ changedAt: -1 }, { name: 'changeLogs_changedAt' });

  // ── space_photos ──────────────────────────────────────────────────────────
  const photos = db.collection(c.spacePhotos);
  await photos.createIndex({ spaceId: 1 },           { name: 'photos_spaceId' });
  await photos.createIndex({ publicUrl: 1 },       { unique: true, sparse: true, name: 'photos_publicUrl_unique' });
  await photos.createIndex({ spaceId: 1, type: 1 },  { name: 'photos_spaceId_type' });
  await photos.createIndex({ spaceId: 1, createdAt: -1 }, { name: 'photos_spaceId_createdAt' });
  await photos.createIndex({ type: 1, createdAt: -1 },  { name: 'photos_type_createdAt' });
  await photos.createIndex({ createdAt: -1 },       { name: 'photos_createdAt' });
  await photos.createIndex({ sizeBytes: -1 },       { name: 'photos_sizeBytes' });
  await photos.createIndex({ appealScore: -1 },     { name: 'photos_appealScore' });
  await photos.createIndex({ folder: 1 },           { name: 'photos_folder' });
  await photos.createIndex({ fsExists: 1 },         { name: 'photos_fsExists' });
  await photos.createIndex({ tags: 1 },             { name: 'photos_tags' });
  // Missing indexes identified in audit:
  await photos.createIndex({ isOrphaned: 1 },       { name: 'photos_isOrphaned' });
  await photos.createIndex({ fsExists: 1, spaceId: 1 }, { name: 'photos_fsExists_spaceId' });
  await photos.createIndex({ spaceId: 1 }, { name: 'photos_unlinked_partial', partialFilterExpression: { spaceId: null } });
  // Task 7: enrichment-specific indexes
  await photos.createIndex({ spaceId: 1, sourceType: 1 }, { name: 'photos_spaceId_sourceType' });
  await photos.createIndex({ downloaded: 1, spaceId: 1 }, { name: 'photos_downloaded_spaceId' });
  // Supports upsertCapturedPhotoUrls filter: { originalUrl, spaceId }
  await photos.createIndex({ originalUrl: 1, spaceId: 1 }, { sparse: true, name: 'photos_originalUrl_spaceId' });

  // ── space_crawl_meta ──────────────────────────────────────────────────────
  const crawlMeta = db.collection(c.spaceCrawlMeta);
  await crawlMeta.createIndex({ spaceId: 1 },  { unique: true, name: 'crawlMeta_spaceId_unique' });
  await crawlMeta.createIndex({ jobId: 1 },  { name: 'crawlMeta_jobId' });

  // ── space_crawl_jobs ──────────────────────────────────────────────────────
  // TD-08 fix: this was the only modelled collection missing from ensureIndexes.
  const crawlJobs = db.collection(c.spaceCrawlJobs);
  await crawlJobs.createIndex({ jobId: 1 },              { unique: true,  name: 'crawlJobs_jobId_unique' });
  await crawlJobs.createIndex({ status: 1, createdAt: -1 }, { name: 'crawlJobs_status_createdAt' });
  await crawlJobs.createIndex({ createdAt: -1 },         { name: 'crawlJobs_createdAt' });
  // Supports hasActiveJob() dedup query: filter by cityName + status in ['queued','running']
  await crawlJobs.createIndex({ 'input.cityName': 1, status: 1 }, { name: 'crawlJobs_cityName_status' });

  // ── space_sources ─────────────────────────────────────────────────────────
  const spaceSources = db.collection(c.spaceSources);
  await spaceSources.createIndex(
    { spaceId: 1, provider: 1 },
    { unique: true, name: 'spaceSource_space_provider_unique' }
  );
  await spaceSources.createIndex(
    { provider: 1, providerPlaceId: 1 },
    { unique: true, sparse: true, name: 'spaceSource_provider_placeId_unique' }
  );
  await spaceSources.createIndex(
    { provider: 1, providerUrlHash: 1 },
    { unique: true, sparse: true, name: 'spaceSource_provider_urlHash_unique' }
  );
  await spaceSources.createIndex(
    { provider: 1, lastCrawledAt: -1 },
    { name: 'spaceSource_provider_lastCrawledAt' }
  );

  // ── space_categories ──────────────────────────────────────────────────────
  const categories = db.collection(c.spaceCategories);
  await categories.createIndex({ slug: 1 },  { unique: true, name: 'categories_slug_unique' });

  // ── space_amenities ───────────────────────────────────────────────────────
  const amenities = db.collection(c.spaceAmenities);
  await amenities.createIndex({ slug: 1 },   { unique: true, name: 'amenities_slug_unique' });

  // ── space_place_types ─────────────────────────────────────────────────────
  const placeTypes = db.collection(c.spacePlaceTypes);
  await placeTypes.createIndex({ slug: 1 },  { unique: true, name: 'placeTypes_slug_unique' });

  // ── photo_sync_state ──────────────────────────────────────────────────────
  const syncState = db.collection('photo_sync_state');
  await syncState.createIndex({ key: 1 },    { unique: true, name: 'syncState_key_unique' });

  // ── system_states ─────────────────────────────────────────────────────────
  const systemStates = db.collection('system_states');
  await systemStates.createIndex({ key: 1 }, { unique: true, name: 'systemStates_key_unique' });

  // ── opg_id_counters ────────────────────────────────────────────────────────
  const opgIdCounters = db.collection('opg_id_counters');
  await opgIdCounters.createIndex(
    { prefix: 1 },
    { unique: true, name: 'opgIdCounters_prefix_unique' }
  );

  // ── enrichment-specific spaces indexes (Task 7) ────────────────────────────
  // Supports dashboard query: list spaces by city that need re-enrichment
  await spaces.createIndex(
    { 'atlas.city': 1, 'operationalData.lastHoursVerifiedAt': 1 },
    { sparse: true, name: 'spaces_city_lastHoursVerifiedAt' }
  );
  // Supports enrichment targeting by areaName + enrichment status
  await spaces.createIndex(
    { areaName: 1, 'enrichmentMeta.status': 1 },
    { name: 'spaces_areaName_enrichmentStatus' }
  );
  await spaces.createIndex(
    { 'crawl.mediaStatus': 1 },
    { sparse: true, name: 'spaces_crawl_mediaStatus' }
  );

  // ── opgId indexes (Task 3) ────────────────────────────────────────────────
  // spaces: unique+sparse allows safe backfill without blocking existing docs
  await db.collection(c.spaces).createIndex(
    { opgId: 1 }, { unique: true, sparse: true, name: 'opgId_unique' }
  );
  await db.collection(c.spaceReviews).createIndex(
    { opgId: 1 }, { name: 'opgId_idx' }
  );
  await db.collection(c.spacePhotos).createIndex(
    { opgId: 1 }, { name: 'opgId_idx' }
  );
  await db.collection(c.spaceCrawlMeta).createIndex(
    { opgId: 1 }, { name: 'opgId_idx' }
  );
  await db.collection(c.spaceChangeLogs).createIndex(
    { opgId: 1 }, { name: 'opgId_idx' }
  );
  await db.collection(c.spaceCrawlJobs).createIndex(
    { opgId: 1 }, { name: 'opgId_idx' }
  );

  logger.info('✅ DB indexes verified/created (all collections)');
}

module.exports = { ensureIndexes };
