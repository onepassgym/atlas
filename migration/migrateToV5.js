'use strict';
/**
 * migration/migrateToV5.js
 *
 * ⚠️  DESTRUCTIVE/IRREVERSIBLE — take a DB snapshot before running.
 *
 * This script migrates the atlas DB from the old gym-based schema to the v5
 * opg-atlas schema. It:
 *
 * 1. Renames collections: gyms→spaces, gym_reviews→space_reviews, etc.
 * 2. Reshapes documents to match the v5 Space schema.
 * 3. Backfills new-format opgIds (SPC-/RVW-/PHT-/CHN-/LOC-).
 * 4. Rewrites child refs (gymId→spaceId, adds spaceOpgId).
 * 5. Persists an old→new id map in a `_migration_id_map` collection.
 * 6. Folds gym_crawl_meta into spaces.crawl{}.
 *
 * Idempotent: tracks progress via a `_migration_state` collection.
 * Resumable: processes in batches, commits progress after each batch.
 *
 * Usage: node migration/migrateToV5.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { makeOpgId } = require('../src/utils/opgId');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

const MONGO_URI = process.env.MONGODB_URI || process.env.DEV_MONGODB_URI || 'mongodb://127.0.0.1:27328/atlas';

async function connect() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to: ${MONGO_URI}`);
  return mongoose.connection.db;
}

async function getState(db) {
  const col = db.collection('_migration_state');
  const state = await col.findOne({ _id: 'v5_migration' });
  return state || { _id: 'v5_migration', phase: 'not_started', lastProcessedId: null, stats: {} };
}

async function saveState(db, state) {
  await db.collection('_migration_state').replaceOne(
    { _id: 'v5_migration' },
    state,
    { upsert: true }
  );
}

// ── Phase 1: Rename collections ──────────────────────────────────────────────

async function renameCollections(db) {
  const renames = [
    ['gyms', 'spaces'],
    ['gym_reviews', 'space_reviews'],
    ['gym_photos', 'space_photos'],
    ['gym_categories', 'space_categories'],
    ['gym_amenities', 'space_amenities'],
    ['gym_chains', 'space_chains'],
    ['gymChangeLogs', 'space_change_logs'],
  ];

  for (const [from, to] of renames) {
    try {
      const collections = await db.listCollections({ name: from }).toArray();
      if (collections.length > 0) {
        if (!DRY_RUN) await db.collection(from).rename(to);
        console.log(`  ✓ Renamed ${from} → ${to}`);
      } else {
        console.log(`  - Skip ${from} (already renamed or doesn't exist)`);
      }
    } catch (err) {
      if (err.code === 48) { // NamespaceExists
        console.log(`  - Skip ${from} → ${to} (target already exists)`);
      } else {
        throw err;
      }
    }
  }

  // Drop gym_crawl_meta (will be folded into spaces.crawl{})
  try {
    const exists = await db.listCollections({ name: 'gym_crawl_meta' }).toArray();
    if (exists.length > 0) {
      console.log('  - gym_crawl_meta will be folded into spaces.crawl{} (kept until fold completes)');
    }
  } catch (_) {}

  // Drop gym_place_types (folded into spaces.tags[])
  try {
    const exists = await db.listCollections({ name: 'gym_place_types' }).toArray();
    if (exists.length > 0) {
      if (!DRY_RUN) await db.collection('gym_place_types').drop();
      console.log('  ✓ Dropped gym_place_types (folded into spaces.tags[])');
    }
  } catch (_) {}
}

// ── Phase 2: Reshape spaces + backfill opgIds ────────────────────────────────

async function migrateSpaces(db, state) {
  const spaces = db.collection('spaces');
  const idMap = db.collection('_migration_id_map');
  const crawlMeta = db.collection('gym_crawl_meta');

  const query = state.lastProcessedId
    ? { _id: { $gt: state.lastProcessedId } }
    : {};

  let processed = 0;
  let cursor = spaces.find(query).sort({ _id: 1 }).limit(BATCH_SIZE);

  while (true) {
    const batch = await cursor.toArray();
    if (batch.length === 0) break;

    const bulkOps = [];
    const mapOps = [];

    for (const doc of batch) {
      const oldOpgId = doc.opgId || null;
      const newOpgId = makeOpgId('space');

      // Fold crawl_meta into crawl{}
      let crawl = doc.crawl || {};
      if (!crawl.firstCrawledAt) {
        const meta = await crawlMeta.findOne({ gymId: doc._id });
        if (meta) {
          crawl = {
            jobId: meta.jobId,
            status: meta.crawlStatus || 'completed',
            version: meta.crawlVersion || 1,
            firstCrawledAt: meta.firstCrawledAt,
            lastCrawledAt: meta.lastCrawledAt,
            sourceUrl: meta.sourceUrl,
          };
        }
      }

      // Build v5 fields
      const $set = {
        opgId: newOpgId,
        createdVia: doc.createdVia || 'crawler',
        crawl,
        // Rename geoLocation → location if not already set
        ...(doc.geoLocation && !doc.location ? { location: doc.geoLocation } : {}),
        // Map atlas06{} → opg{}
        opg: {
          isListed: doc.atlas06?.isListed || false,
          isVerified: doc.atlas06?.isVerified || false,
          isPartner: doc.atlas06?.isPartner || false,
          isFeatured: false,
          planSlugs: doc.atlas06?.planIds || [],
        },
        // Map enrichmentMeta → enrichment
        enrichment: {
          status: doc.enrichmentMeta?.status || 'never',
          lastSuccess: doc.enrichmentMeta?.lastSuccess || null,
          lastAttempt: doc.enrichmentMeta?.lastAttempt || null,
          consecutiveErrors: doc.enrichmentMeta?.consecutiveErrors || 0,
          error: doc.enrichmentMeta?.error || null,
        },
        // Ensure v5 fields
        primaryCategorySlug: doc.primaryCategorySlug || doc.category || null,
        categorySlugs: doc.categorySlugs || (doc.categories || []).filter(Boolean),
        amenitySlugs: doc.amenitySlugs || [],
        city: doc.city || doc.areaName || null,
        country: doc.country || 'IN',
        dataCompleteness: doc.dataCompleteness || doc.crawlMeta?.dataCompleteness || 0,
      };

      const $unset = {
        atlas06: '',
        enrichmentMeta: '',
        geoLocation: '',
        categoryId: '',
        amenityIds: '',
        rawPhotos: '',
        rawAmenities: '',
        rawCrawlMeta: '',
        crawlMeta: '',
        crawlJobId: '',
        category: '',
        primaryType: '',
        types: '',
        chainId: '',
        chainSlug: '',
        chainName: '',
        isChainMember: '',
        addressParts: '',
        popularTimes: '',
        reviewSummary: '',
        visualAppealScore: '',
        permanentlyClosed: '',
        temporarilyClosed: '',
        claimedByOwner: '',
        coverPhoto: '',
        pricing: '',
        operationalData: '',
        extraAttributes: '',
      };

      bulkOps.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set, $unset },
        }
      });

      // Persist id mapping
      if (oldOpgId) {
        mapOps.push({
          updateOne: {
            filter: { oldOpgId },
            update: { $set: { oldOpgId, newOpgId, entityType: 'space', mongoId: doc._id } },
            upsert: true,
          }
        });
      }
    }

    if (!DRY_RUN && bulkOps.length) {
      await spaces.bulkWrite(bulkOps, { ordered: false });
      if (mapOps.length) await idMap.bulkWrite(mapOps, { ordered: false });
    }

    processed += batch.length;
    state.lastProcessedId = batch[batch.length - 1]._id;
    state.stats.spacesProcessed = (state.stats.spacesProcessed || 0) + batch.length;
    if (!DRY_RUN) await saveState(db, state);

    console.log(`  Spaces: ${processed} processed (last: ${state.lastProcessedId})`);

    if (batch.length < BATCH_SIZE) break;
    cursor = spaces.find({ _id: { $gt: state.lastProcessedId } }).sort({ _id: 1 }).limit(BATCH_SIZE);
  }

  return processed;
}

// ── Phase 3: Rewrite child refs ──────────────────────────────────────────────

async function migrateChildRefs(db) {
  const spaces = db.collection('spaces');
  const reviews = db.collection('space_reviews');
  const photos = db.collection('space_photos');
  const changeLogs = db.collection('space_change_logs');

  // Build opgId lookup from spaces
  console.log('  Building spaceId → opgId lookup...');
  const lookup = new Map();
  const cursor = spaces.find({}, { projection: { _id: 1, opgId: 1 } }).batchSize(2000);
  for await (const doc of cursor) {
    lookup.set(doc._id.toString(), doc.opgId);
  }
  console.log(`  Lookup built: ${lookup.size} spaces`);

  // Rename gymId → spaceId and add spaceOpgId on reviews
  console.log('  Migrating space_reviews...');
  let reviewBatch = [];
  const reviewCursor = reviews.find({ gymId: { $exists: true } }).batchSize(1000);
  let reviewCount = 0;
  for await (const doc of reviewCursor) {
    const spaceOpgId = lookup.get(doc.gymId.toString()) || null;
    reviewBatch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { spaceId: doc.gymId, spaceOpgId, opgId: doc.opgId || makeOpgId('review'), createdVia: 'crawler' },
          $unset: { gymId: '' },
        },
      }
    });
    if (reviewBatch.length >= BATCH_SIZE) {
      if (!DRY_RUN) await reviews.bulkWrite(reviewBatch, { ordered: false });
      reviewCount += reviewBatch.length;
      reviewBatch = [];
    }
  }
  if (reviewBatch.length && !DRY_RUN) await reviews.bulkWrite(reviewBatch, { ordered: false });
  reviewCount += reviewBatch.length;
  console.log(`  ✓ Reviews migrated: ${reviewCount}`);

  // Rename gymId → spaceId and add spaceOpgId on photos
  console.log('  Migrating space_photos...');
  let photoBatch = [];
  const photoCursor = photos.find({ gymId: { $exists: true } }).batchSize(1000);
  let photoCount = 0;
  for await (const doc of photoCursor) {
    const spaceOpgId = lookup.get(doc.gymId.toString()) || null;
    photoBatch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { spaceId: doc.gymId, spaceOpgId, opgId: doc.opgId || makeOpgId('photo'), createdVia: 'crawler' },
          $unset: { gymId: '' },
        },
      }
    });
    if (photoBatch.length >= BATCH_SIZE) {
      if (!DRY_RUN) await photos.bulkWrite(photoBatch, { ordered: false });
      photoCount += photoBatch.length;
      photoBatch = [];
    }
  }
  if (photoBatch.length && !DRY_RUN) await photos.bulkWrite(photoBatch, { ordered: false });
  photoCount += photoBatch.length;
  console.log(`  ✓ Photos migrated: ${photoCount}`);

  // Rename gymId → spaceId on change logs
  console.log('  Migrating space_change_logs...');
  let logBatch = [];
  const logCursor = changeLogs.find({ gymId: { $exists: true } }).batchSize(1000);
  let logCount = 0;
  for await (const doc of logCursor) {
    const spaceOpgId = lookup.get(doc.gymId.toString()) || null;
    logBatch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { spaceId: doc.gymId, spaceOpgId },
          $unset: { gymId: '', opgId: '' },
        },
      }
    });
    if (logBatch.length >= BATCH_SIZE) {
      if (!DRY_RUN) await changeLogs.bulkWrite(logBatch, { ordered: false });
      logCount += logBatch.length;
      logBatch = [];
    }
  }
  if (logBatch.length && !DRY_RUN) await changeLogs.bulkWrite(logBatch, { ordered: false });
  logCount += logBatch.length;
  console.log(`  ✓ ChangeLogs migrated: ${logCount}`);
}

// ── Phase 4: Drop obsolete collections ───────────────────────────────────────

async function dropObsolete(db) {
  const toDrop = ['gym_crawl_meta'];
  for (const name of toDrop) {
    try {
      const exists = await db.listCollections({ name }).toArray();
      if (exists.length > 0) {
        if (!DRY_RUN) await db.collection(name).drop();
        console.log(`  ✓ Dropped ${name}`);
      }
    } catch (_) {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Atlas v5 Migration ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`${'═'.repeat(60)}\n`);

  const db = await connect();
  let state = await getState(db);

  if (state.phase === 'completed') {
    console.log('Migration already completed. Nothing to do.');
    process.exit(0);
  }

  // Phase 1: Rename collections
  if (state.phase === 'not_started' || state.phase === 'renaming') {
    console.log('\n[Phase 1] Renaming collections...');
    state.phase = 'renaming';
    await renameCollections(db);
    state.phase = 'reshaping';
    if (!DRY_RUN) await saveState(db, state);
  }

  // Phase 2: Reshape spaces
  if (state.phase === 'reshaping') {
    console.log('\n[Phase 2] Reshaping spaces + backfilling opgIds...');
    const count = await migrateSpaces(db, state);
    console.log(`  ✓ Total spaces processed: ${count}`);
    state.phase = 'child_refs';
    state.lastProcessedId = null;
    if (!DRY_RUN) await saveState(db, state);
  }

  // Phase 3: Rewrite child refs
  if (state.phase === 'child_refs') {
    console.log('\n[Phase 3] Rewriting child references...');
    await migrateChildRefs(db);
    state.phase = 'cleanup';
    if (!DRY_RUN) await saveState(db, state);
  }

  // Phase 4: Drop obsolete
  if (state.phase === 'cleanup') {
    console.log('\n[Phase 4] Dropping obsolete collections...');
    await dropObsolete(db);
    state.phase = 'completed';
    state.completedAt = new Date();
    if (!DRY_RUN) await saveState(db, state);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Migration ${DRY_RUN ? 'DRY RUN' : ''} complete!`);
  console.log(`  Stats: ${JSON.stringify(state.stats)}`);
  console.log(`${'═'.repeat(60)}\n`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
