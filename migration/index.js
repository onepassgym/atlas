'use strict';
/**
 * migration/index.js
 *
 * Migration scheduler — runs as a long-lived process alongside the server.
 * Registered crons:
 *   00:01 AM  — runGymSchemaMigration()  (legacy gym schema backfill)
 *   04:00 AM  — runOpgIdMigration()      (backfill opgId on any gyms missing it)
 *
 * Manual triggers (still supported):
 *   node migration/index.js --run=addOpgIds
 *   npm run migrate:opgid
 *   npm run migrate:opgid:prod
 */

const cron          = require('node-cron');
const mongoose      = require('mongoose');
const { connectDB, disconnectDB } = require('../src/db/connection');
const migrateGym    = require('./migrateGym');
const logger        = require('../src/utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let _isConnected = false;

async function ensureConnected() {
  if (!_isConnected) {
    await connectDB();
    _isConnected = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Job 1 — Gym schema migration  (12:01 AM daily)
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE    = 20;
const BATCH_DELAY   = 2000;
const OP_DELAY      = 100;

async function runGymSchemaMigration() {
  logger.info('[migration] Starting gym schema migration...');
  await ensureConnected();
  const db = mongoose.connection.db;

  let skip = 0, totalProcessed = 0, succeeded = 0, failed = 0;
  const startTime = Date.now();

  while (true) {
    try {
      const batch = await db.collection('gyms')
        .find({ parsed: { $ne: true } })
        .limit(BATCH_SIZE)
        .skip(skip)
        .toArray();

      if (batch.length === 0) break;
      logger.info(`[migration] Processing batch of ${batch.length} (skip: ${skip})`);

      for (const gym of batch) {
        await migrateGym(gym);
        const log = await db.collection('gym_migration_logs')
          .findOne({ gymId: gym._id }, { sort: { processedAt: -1 } });
        if (log && log.status === 'success') succeeded++;
        else failed++;
        totalProcessed++;
        await sleep(OP_DELAY);
      }

      skip = failed;
      await sleep(BATCH_DELAY);
    } catch (err) {
      logger.error('[migration] Batch error: ' + err.message);
      break;
    }
  }

  const dur = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
  logger.info(`[migration] Done — total: ${totalProcessed}, ok: ${succeeded}, fail: ${failed}, ${dur}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Job 2 — opgId backfill  (04:00 AM daily, IST)
//  Safe to run nightly — idempotent, skips gyms that already have opgId.
// ─────────────────────────────────────────────────────────────────────────────

async function runOpgIdMigration() {
  const GymModel             = require('../src/db/gymModel');
  const { Review }           = require('../src/db/reviewModel');
  const Photo                = require('../src/db/photoModel');
  const CrawlMeta            = require('../src/db/crawlMetaModel');
  const GymChangeLog         = require('../src/db/gymChangeLogModel');
  const CrawlJob             = require('../src/db/crawlJobModel');
  const { generateUniqueOpgId } = require('../src/utils/opgId');

  await ensureConnected();

  const pending = await GymModel.countDocuments({ opgId: { $exists: false } });
  logger.info(`[opgId migration] Started — pending: ${pending}`);

  if (pending === 0) {
    logger.info('[opgId migration] All gyms already have opgId. Nothing to do.');
    return;
  }

  const cursor = GymModel
    .find({ opgId: { $exists: false } })
    .select('_id name')
    .lean()
    .cursor();

  let processed = 0, assigned = 0, errors = 0;

  for await (const gym of cursor) {
    try {
      const opgId = await generateUniqueOpgId(GymModel);
      await Promise.all([
        GymModel.updateOne(   { _id: gym._id },  { $set: { opgId } }),
        Review.updateMany(    { gymId: gym._id }, { $set: { opgId } }),
        Photo.updateMany(     { gymId: gym._id }, { $set: { opgId } }),
        CrawlMeta.updateOne(  { gymId: gym._id }, { $set: { opgId } }),
        GymChangeLog.updateMany({ gymId: gym._id }, { $set: { opgId } }),
        CrawlJob.updateMany(  { gymIds: gym._id }, { $set: { opgId } }),
      ]);
      assigned++;
    } catch (e) {
      logger.error(`[opgId migration] [${gym._id}] ${gym.name}: ${e.message}`);
      errors++;
    }
    processed++;
    if (processed % 100 === 0) {
      const pct = Math.round(processed / pending * 100);
      logger.info(`[opgId migration] Progress: ${processed}/${pending} (${pct}%)`);
    }
  }

  logger.info(`[opgId migration] Done — total: ${pending} | assigned: ${assigned} | errors: ${errors}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Startup & scheduling
// ─────────────────────────────────────────────────────────────────────────────

// Allow manual one-shot: node migration/index.js --run=addOpgIds
const manualRun = process.argv.find(a => a.startsWith('--run='));
if (manualRun === '--run=addOpgIds') {
  // Standalone script mode — addOpgIds.js handles its own connect/disconnect
  require('./addOpgIds');
} else if (require.main === module) {
  // Long-lived scheduler mode
  (async () => {
    await ensureConnected();

    // 00:01 AM — gym schema migration
    cron.schedule('1 0 * * *', async () => {
      logger.info('[cron] 00:01 trigger → runGymSchemaMigration');
      await runGymSchemaMigration();
    }, { timezone: 'Asia/Kolkata' });

    // 03:00 AM — opgId backfill (idempotent nightly sweep)
    cron.schedule('0 3 * * *', async () => {
      logger.info('[cron] 03:00 trigger → runOpgIdMigration');
      await runOpgIdMigration();
    }, { timezone: 'Asia/Kolkata' });

    logger.info('⏰ Migration scheduler active:');
    logger.info('   00:01 IST — gym schema migration');
    logger.info('   03:00 IST — opgId backfill (nightly sweep)');
  })();
}

module.exports = {
  runGymSchemaMigration,
  runOpgIdMigration,
  runNow: async () => {
    await runGymSchemaMigration();
    await disconnectDB();
  },
};
