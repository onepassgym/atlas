'use strict';
const { connectDB, disconnectDB } = require('../src/db/connection');
const mongoose = require('mongoose');

// v5 collection index definitions — mirrors opg-db-architecture.dbml
const INDEX_SPECS = [
  // ── spaces ────────────────────────────────────────────────────────────────
  { col: 'spaces', spec: { opgId: 1 },           opts: { unique: true, sparse: true } },
  { col: 'spaces', spec: { slug: 1 },            opts: { unique: true, sparse: true } },
  { col: 'spaces', spec: { placeId: 1 },         opts: { sparse: true } },
  { col: 'spaces', spec: { googleMapsUrl: 1 },   opts: {} },
  { col: 'spaces', spec: { 'contact.phone': 1 }, opts: { sparse: true } },
  { col: 'spaces', spec: { location: '2dsphere' }, opts: { sparse: true } },
  { col: 'spaces', spec: { name: 'text', description: 'text', areaName: 'text' }, opts: {} },
  { col: 'spaces', spec: { cityOpgId: 1, primaryCategorySlug: 1, qualityScore: -1 }, opts: { name: 'idx_city_cat_quality' } },
  { col: 'spaces', spec: { city: 1, primaryCategorySlug: 1 }, opts: { name: 'idx_city_cat_display' } },
  { col: 'spaces', spec: { rating: -1, qualityScore: -1 }, opts: { name: 'idx_rank' } },
  { col: 'spaces', spec: { chainOpgId: 1 },      opts: { sparse: true } },
  { col: 'spaces', spec: { sources: 1 },         opts: {} },
  { col: 'spaces', spec: { 'enrichment.stage': 1, updatedAt: 1 }, opts: { name: 'idx_enrich_stage_updated' } },
  { col: 'spaces', spec: { 'enrichment.nextEnrichAt': 1 }, opts: { sparse: true } },
  { col: 'spaces', spec: { qualityScore: -1 },   opts: {} },
  { col: 'spaces', spec: { dataCompleteness: -1 }, opts: {} },

  // ── space_reviews ──────────────────────────────────────────────────────────
  { col: 'space_reviews', spec: { spaceOpgId: 1, publishedAt: -1 }, opts: { name: 'idx_space_recent' } },
  { col: 'space_reviews', spec: { spaceOpgId: 1, rating: -1 },      opts: { name: 'idx_space_rating' } },
  { col: 'space_reviews', spec: { reviewId: 1 },                    opts: { unique: true, sparse: true } },
  { col: 'space_reviews', spec: { opgId: 1 },                       opts: { unique: true, sparse: true } },
  { col: 'space_reviews', spec: { source: 1 },                      opts: {} },

  // ── space_photos ───────────────────────────────────────────────────────────
  { col: 'space_photos', spec: { spaceOpgId: 1, order: 1 },         opts: { name: 'idx_space_order' } },
  { col: 'space_photos', spec: { publicUrl: 1 },                    opts: { unique: true, sparse: true } },
  { col: 'space_photos', spec: { originalUrl: 1, spaceOpgId: 1 },   opts: { sparse: true } },
  { col: 'space_photos', spec: { type: 1 },                         opts: {} },
  { col: 'space_photos', spec: { opgId: 1 },                        opts: { unique: true, sparse: true } },

  // ── space_chains ───────────────────────────────────────────────────────────
  { col: 'space_chains', spec: { slug: 1 }, opts: { unique: true } },
  { col: 'space_chains', spec: { opgId: 1 }, opts: { unique: true, sparse: true } },

  // ── space_categories ───────────────────────────────────────────────────────
  { col: 'space_categories', spec: { slug: 1 }, opts: { unique: true } },
  { col: 'space_categories', spec: { key: 1 },  opts: { unique: true } },

  // ── space_amenities ────────────────────────────────────────────────────────
  { col: 'space_amenities', spec: { slug: 1 }, opts: { unique: true } },
  { col: 'space_amenities', spec: { key: 1 },  opts: { unique: true } },

  // ── locations ──────────────────────────────────────────────────────────────
  { col: 'locations', spec: { opgId: 1 },           opts: { unique: true, sparse: true } },
  { col: 'locations', spec: { slug: 1 },            opts: { unique: true } },
  { col: 'locations', spec: { center: '2dsphere' }, opts: { sparse: true } },
  { col: 'locations', spec: { type: 1, isServiceable: 1 }, opts: { name: 'idx_loc_type_serviceable' } },
  { col: 'locations', spec: { parentOpgId: 1, type: 1 },   opts: { name: 'idx_loc_parent' } },
  { col: 'locations', spec: { aliases: 1 },                opts: {} },

  // ── gym_crawl_jobs ─────────────────────────────────────────────────────────
  { col: 'gym_crawl_jobs', spec: { jobId: 1 },   opts: { unique: true } },
  { col: 'gym_crawl_jobs', spec: { status: 1 },  opts: {} },
  { col: 'gym_crawl_jobs', spec: { createdAt: -1 }, opts: {} },

  // ── space_change_logs ──────────────────────────────────────────────────────
  { col: 'space_change_logs', spec: { spaceOpgId: 1, changedAt: -1 }, opts: {} },

  // ── enrichment_logs ────────────────────────────────────────────────────────
  { col: 'enrichment_logs', spec: { spaceOpgId: 1, createdAt: -1 }, opts: {} },
];

async function createIndexes() {
  await connectDB();
  const db = mongoose.connection.db;
  console.log('Creating v5 indexes...');

  let created = 0;
  let skipped = 0;

  for (const { col, spec, opts } of INDEX_SPECS) {
    try {
      await db.collection(col).createIndex(spec, opts);
      created++;
    } catch (err) {
      if (err.code === 85 || err.code === 86) {
        // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict — index exists with different options
        skipped++;
      } else {
        console.warn(`  ⚠ ${col}: ${err.message}`);
        skipped++;
      }
    }
  }

  console.log(`Indexes: ${created} created, ${skipped} skipped/conflict.`);
  await disconnectDB();
}

if (require.main === module) {
  createIndexes().catch(console.error).finally(() => process.exit(0));
}

module.exports = createIndexes;
