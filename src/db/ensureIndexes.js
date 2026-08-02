'use strict';
/**
 * ensureIndexes.js
 *
 * Consolidates ALL index creation across every collection (v5 opg-atlas).
 * Called once after MongoDB connects.
 * Uses the native MongoDB driver (mongoose.connection.db) so that we can
 * pass the full options object without Mongoose interfering.
 */
const mongoose = require('mongoose');
const logger   = require('../utils/logger');

async function ensureIndexes() {
  const db = mongoose.connection.db;

  // ── spaces ────────────────────────────────────────────────────────────────
  const spaces = db.collection('spaces');
  await spaces.createIndex({ opgId: 1 },          { unique: true, sparse: true, name: 'opgId_unique' });
  await spaces.createIndex({ slug: 1 },           { unique: true, sparse: true, name: 'slug_unique' });
  await spaces.createIndex({ googleMapsUrl: 1 },  { name: 'googleMapsUrl_1' });
  await spaces.createIndex({ placeId: 1 },        { sparse: true, name: 'placeId_sparse' });
  await spaces.createIndex({ location: '2dsphere' }, { sparse: true, name: 'location_2dsphere' });
  await spaces.createIndex({ 'contact.phone': 1 }, { sparse: true, name: 'contact_phone_sparse' });
  await spaces.createIndex({ areaName: 1 },        { name: 'areaName_1' });
  await spaces.createIndex({ chainOpgId: 1 },      { sparse: true, name: 'chainOpgId_sparse' });
  // v5 compound indexes
  await spaces.createIndex({ cityOpgId: 1, primaryCategorySlug: 1, qualityScore: -1 }, { name: 'idx_city_cat_quality' });
  await spaces.createIndex({ city: 1, primaryCategorySlug: 1 },                        { name: 'idx_city_cat_display' });
  await spaces.createIndex({ rating: -1, qualityScore: -1 },                           { name: 'idx_rank' });
  // Operational
  await spaces.createIndex({ 'crawl.status': 1 },      { name: 'crawl_status' });
  await spaces.createIndex({ 'enrichment.status': 1 }, { name: 'enrichment_status' });
  await spaces.createIndex({ deletedAt: 1 },           { sparse: true, name: 'deletedAt_sparse' });

  // ── space_reviews ─────────────────────────────────────────────────────────
  const reviews = db.collection('space_reviews');
  await reviews.createIndex({ spaceId: 1 },    { name: 'reviews_spaceId' });
  await reviews.createIndex({ spaceOpgId: 1 }, { name: 'reviews_spaceOpgId' });
  await reviews.createIndex({ reviewId: 1 },   { unique: true, name: 'reviewId_unique' });
  await reviews.createIndex({ spaceOpgId: 1, publishedAt: -1 }, { name: 'idx_space_recent' });
  await reviews.createIndex({ spaceOpgId: 1, rating: 1 },       { name: 'idx_space_rating' });

  // ── space_change_logs ─────────────────────────────────────────────────────
  const logs = db.collection('space_change_logs');
  await logs.createIndex({ spaceId: 1 },    { name: 'changeLogs_spaceId' });
  await logs.createIndex({ spaceOpgId: 1 }, { name: 'changeLogs_spaceOpgId' });
  await logs.createIndex({ changedAt: -1 }, { name: 'changeLogs_changedAt' });

  // ── space_photos ──────────────────────────────────────────────────────────
  const photos = db.collection('space_photos');
  await photos.createIndex({ opgId: 1 },               { name: 'photos_opgId' });
  await photos.createIndex({ spaceId: 1 },             { name: 'photos_spaceId' });
  await photos.createIndex({ spaceOpgId: 1 },          { name: 'photos_spaceOpgId' });
  await photos.createIndex({ publicUrl: 1 },           { unique: true, sparse: true, name: 'photos_publicUrl_unique' });
  await photos.createIndex({ originalUrl: 1, spaceId: 1 }, { sparse: true, name: 'photos_originalUrl_spaceId' });
  await photos.createIndex({ spaceId: 1, type: 1 },    { name: 'photos_spaceId_type' });
  await photos.createIndex({ spaceId: 1, sourceType: 1 }, { name: 'photos_spaceId_sourceType' });
  await photos.createIndex({ downloaded: 1, spaceId: 1 }, { name: 'photos_downloaded_spaceId' });
  await photos.createIndex({ spaceOpgId: 1, order: 1 }, { name: 'idx_space_order' });

  // ── gym_crawl_jobs (internal ops — not a v5 app table) ────────────────────
  const crawlJobs = db.collection('gym_crawl_jobs');
  await crawlJobs.createIndex({ jobId: 1 },              { unique: true, name: 'crawlJobs_jobId_unique' });
  await crawlJobs.createIndex({ status: 1, createdAt: -1 }, { name: 'crawlJobs_status_createdAt' });
  await crawlJobs.createIndex({ createdAt: -1 },         { name: 'crawlJobs_createdAt' });
  await crawlJobs.createIndex({ 'input.cityName': 1, status: 1 }, { name: 'crawlJobs_cityName_status' });

  // ── space_categories ──────────────────────────────────────────────────────
  const categories = db.collection('space_categories');
  await categories.createIndex({ slug: 1 }, { unique: true, name: 'categories_slug_unique' });

  // ── space_amenities ───────────────────────────────────────────────────────
  const amenities = db.collection('space_amenities');
  await amenities.createIndex({ slug: 1 }, { unique: true, name: 'amenities_slug_unique' });

  // ── space_chains ──────────────────────────────────────────────────────────
  const chains = db.collection('space_chains');
  await chains.createIndex({ opgId: 1 }, { unique: true, sparse: true, name: 'chains_opgId_unique' });
  await chains.createIndex({ slug: 1 },  { unique: true, name: 'chains_slug_unique' });

  // ── locations ─────────────────────────────────────────────────────────────
  const locations = db.collection('locations');
  await locations.createIndex({ opgId: 1 },  { unique: true, sparse: true, name: 'locations_opgId_unique' });
  await locations.createIndex({ slug: 1 },   { unique: true, name: 'locations_slug_unique' });
  await locations.createIndex({ center: '2dsphere' }, { sparse: true, name: 'locations_center_2dsphere' });
  await locations.createIndex({ type: 1, isServiceable: 1 }, { name: 'idx_loc_type_serviceable' });
  await locations.createIndex({ parentOpgId: 1, type: 1 },   { name: 'idx_loc_parent' });
  await locations.createIndex({ aliases: 1 }, { name: 'locations_aliases' });

  // ── system_states ─────────────────────────────────────────────────────────
  const systemStates = db.collection('system_states');
  await systemStates.createIndex({ key: 1 }, { unique: true, name: 'systemStates_key_unique' });

  logger.info('✅ DB indexes verified/created (all collections — v5 schema)');
}

module.exports = { ensureIndexes };
