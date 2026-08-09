'use strict';
const mongoose    = require('mongoose');
const Space       = require('../db/spaceModel');
const { PUBLISH_THRESHOLD } = require('./intelligence/scoring');
const logger      = require('../utils/logger');

const SYNC_PROJECTION = {
  opgId:1, slug:1, name:1, location:1, primaryCategorySlug:1, categorySlugs:1,
  amenitySlugs:1, contact:1, rating:1, totalReviews:1, coverUrl:1, description:1,
  qualityScore:1, openingHours:1, chainOpgId:1, opg:1, cityOpgId:1, areaOpgId:1,
  deletedAt:1, updatedAt:1, publishedAt:1,
};

let _coreConn = null;

function getCoreConnection() {
  if (_coreConn && _coreConn.readyState === 1) return _coreConn;

  const uri = process.env.OPG_CORE_MONGO_URI;
  if (!uri) throw new Error('OPG_CORE_MONGO_URI not configured — skipping sync');

  _coreConn = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize:              5,
  });
  return _coreConn;
}

function isEligible(space) {
  return (
    (space.qualityScore || 0) >= PUBLISH_THRESHOLD &&
    (space.enrichment?.stage || 0) === 7 &&
    space.validationState === 'validated' &&
    !space.deletedAt &&
    space.opg?.isListed !== false
  );
}

/**
 * Promote a single space to opg-core.
 * Returns { action: 'published'|'skipped'|'archived'|'error', reason? }.
 */
async function promoteSpace(spaceOpgId) {
  let core;
  try { core = getCoreConnection(); }
  catch (err) {
    logger.warn(`[SyncService] ${err.message}`);
    return { action: 'error', reason: err.message };
  }

  const space = await Space.findOne({ opgId: spaceOpgId }, { ...SYNC_PROJECTION, enrichment: 1, validationState: 1 }).lean();
  if (!space) return { action: 'error', reason: 'Space not found' };

  // Soft-deleted spaces → archive in core
  if (space.deletedAt) {
    await core.collection('spaces').updateOne(
      { opgId: spaceOpgId },
      { $set: { deletedAt: space.deletedAt } },
      { upsert: false }
    );
    await Space.updateOne({ opgId: spaceOpgId }, { $set: { publishedToCore: false, lastSyncedToCore: new Date() } });
    return { action: 'archived' };
  }

  if (!isEligible(space)) {
    return { action: 'skipped', reason: `Not eligible: score=${space.qualityScore}, stage=${space.enrichment?.stage}, state=${space.validationState}` };
  }

  // Build the projected document (exclude internal crawl fields)
  const doc = {};
  for (const key of Object.keys(SYNC_PROJECTION)) {
    if (space[key] !== undefined) doc[key] = space[key];
  }
  doc.publishedAt = space.publishedAt || new Date();

  try {
    await core.collection('spaces').updateOne(
      { opgId: spaceOpgId },
      { $set: doc },
      { upsert: true }
    );
    await Space.updateOne({ opgId: spaceOpgId }, {
      $set: { publishedToCore: true, lastSyncedToCore: new Date(), publishedAt: doc.publishedAt },
    });
    return { action: 'published' };
  } catch (err) {
    logger.error(`[SyncService] Failed to sync ${spaceOpgId}: ${err.message}`);
    return { action: 'error', reason: err.message };
  }
}

/**
 * Batch-promote all eligible spaces.
 * Runs at most `limit` spaces per call to avoid long-running transactions.
 */
async function syncBatch(limit = 100) {
  let core;
  try { core = getCoreConnection(); }
  catch (err) {
    logger.warn(`[SyncService] ${err.message}`);
    return { synced: 0, archived: 0, skipped: 0, errors: [err.message] };
  }

  const result = { synced: 0, archived: 0, skipped: 0, errors: [] };

  // Find spaces that need syncing: never synced OR updated after last sync
  const pending = await Space.find({
    deletedAt: null,
    validationState: 'validated',
    'enrichment.stage': 7,
    qualityScore: { $gte: PUBLISH_THRESHOLD },
    $or: [
      { publishedToCore: { $ne: true } },
      { $expr: { $gt: ['$updatedAt', '$lastSyncedToCore'] } },
    ],
  }, { ...SYNC_PROJECTION, enrichment: 1, validationState: 1 })
    .limit(limit)
    .lean();

  for (const space of pending) {
    try {
      const r = await promoteSpace(space.opgId);
      if (r.action === 'published') result.synced++;
      else if (r.action === 'archived') result.archived++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`${space.opgId}: ${err.message}`);
    }
  }

  // Soft-deleted spaces that are still published in core
  const deleted = await Space.find({ deletedAt: { $ne: null }, publishedToCore: true }, { opgId: 1, deletedAt: 1 })
    .limit(50)
    .lean();

  for (const d of deleted) {
    try {
      await core.collection('spaces').updateOne({ opgId: d.opgId }, { $set: { deletedAt: d.deletedAt } });
      await Space.updateOne({ opgId: d.opgId }, { $set: { publishedToCore: false, lastSyncedToCore: new Date() } });
      result.archived++;
    } catch (err) {
      result.errors.push(`${d.opgId}: ${err.message}`);
    }
  }

  logger.info(`[SyncService] Batch complete: ${result.synced} synced, ${result.archived} archived, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}

async function getStatus() {
  const [pending, total] = await Promise.all([
    Space.countDocuments({ validationState: 'validated', 'enrichment.stage': 7, qualityScore: { $gte: PUBLISH_THRESHOLD }, publishedToCore: { $ne: true }, deletedAt: null }),
    Space.countDocuments({ publishedToCore: true }),
  ]);
  const lastSync = await Space.findOne({ publishedToCore: true }, { lastSyncedToCore: 1 }).sort({ lastSyncedToCore: -1 }).lean();
  return { pending, totalInCore: total, lastSyncAt: lastSync?.lastSyncedToCore || null };
}

module.exports = { syncBatch, promoteSpace, getStatus, isEligible };
