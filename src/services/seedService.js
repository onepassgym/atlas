'use strict';
const CrawlSeed   = require('../db/crawlSeedModel');
const Location    = require('../db/locationModel');
const { generateSingleOpgId } = require('../utils/opgId');
const logger      = require('../utils/logger');

const CONSECUTIVE_ZERO_ALERT = 3;

// ── Priority cadence mapping ──────────────────────────────────────────────────

function assignFrequency(qualityScore, dataAgeDays) {
  if (!qualityScore || dataAgeDays < 3)          return 'hot';
  if (qualityScore >= 50 && dataAgeDays < 30)    return 'active';
  if (qualityScore < 50 || dataAgeDays < 90)     return 'stale';
  return 'dead';
}

function cadenceToMs(frequency) {
  return {
    hot:    6 * 3600 * 1000,     // 6 hours
    active: 7 * 86400 * 1000,    // weekly
    stale:  14 * 86400 * 1000,   // biweekly
    dead:   30 * 86400 * 1000,   // monthly
  }[frequency] || 7 * 86400 * 1000;
}

/**
 * Retrieve the next batch of seeds due for crawling.
 * Priority: lowest nextSeedAt first (seeds most overdue).
 */
async function getNextBatch(limit = 10) {
  return CrawlSeed.find({
    isEnabled:  true,
    deletedAt:  null,
    $or: [
      { nextSeedAt: { $lte: new Date() } },
      { nextSeedAt: null },
      { nextSeedAt: { $exists: false } },
    ],
  })
    .sort({ nextSeedAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Upsert a seed entry.
 * Safe to call multiple times — idempotent by (locationOpgId + categorySlugs).
 */
async function upsertSeed({ locationOpgId, cityName, categorySlugs, priority, frequency }) {
  const existing = await CrawlSeed.findOne({ locationOpgId, deletedAt: null }).lean();
  if (existing) {
    return CrawlSeed.findOneAndUpdate(
      { _id: existing._id },
      { $set: { categorySlugs: categorySlugs || existing.categorySlugs, priority, frequency } },
      { new: true }
    ).lean();
  }

  return CrawlSeed.create({
    locationOpgId,
    cityName,
    categorySlugs: categorySlugs || [],
    priority:      priority || 5,
    frequency:     frequency || 'active',
    nextSeedAt:    new Date(),
    isEnabled:     true,
  });
}

/**
 * Record a completed run result for a seed.
 * Updates nextSeedAt, consecutiveZeroRuns, and historicalAvgYield.
 * Deactivates seeds with too many consecutive zero runs.
 */
async function recordRun(seedId, { recordsFound, googleBlocked = false }) {
  const seed = await CrawlSeed.findById(seedId).lean();
  if (!seed) return;

  const historyAlpha = 0.25; // exponential moving average weight for new value
  const newAvg = seed.historicalAvgYield
    ? (1 - historyAlpha) * seed.historicalAvgYield + historyAlpha * recordsFound
    : recordsFound;

  const update = {
    lastSeedAt:          new Date(),
    nextSeedAt:          new Date(Date.now() + cadenceToMs(seed.frequency)),
    historicalAvgYield:  +newAvg.toFixed(1),
  };

  if (googleBlocked) {
    update.consecutiveGoogleBlocks = (seed.consecutiveGoogleBlocks || 0) + 1;
    if (update.consecutiveGoogleBlocks >= 3) {
      update.frequency = 'stale'; // downgrade Google Maps cadence
    }
  } else {
    update.consecutiveGoogleBlocks = 0;
    update.lastGoodGoogleRunAt     = new Date();
  }

  if (recordsFound === 0 && !googleBlocked) {
    update.consecutiveZeroRuns = (seed.consecutiveZeroRuns || 0) + 1;
    if (update.consecutiveZeroRuns >= CONSECUTIVE_ZERO_ALERT) {
      logger.warn(`[SeedService] Seed ${seed.cityName} has ${update.consecutiveZeroRuns} consecutive zero runs — disabling`);
      update.isEnabled = false;
    }
  } else {
    update.consecutiveZeroRuns = 0;
  }

  await CrawlSeed.updateOne({ _id: seedId }, { $set: update });
}

/**
 * Bootstrap seeds from existing config/schedule.json (one-time migration).
 * Safe to call repeatedly — will not duplicate.
 */
async function migrateSeedsFromScheduleConfig() {
  const scheduleConfig = require('../../config/schedule.json');
  const cities = scheduleConfig.cities || [];

  let created = 0;
  for (const city of cities) {
    const name = typeof city === 'string' ? city : (city.name || city.city);
    if (!name) continue;

    const freq = city.frequency || scheduleConfig.defaultFrequency || 'weekly';
    const mappedFreq = { weekly: 'active', biweekly: 'stale', monthly: 'dead' }[freq] || 'active';

    // Try to find locationOpgId from DB
    const loc = await Location.findOne({
      $or: [{ slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') }, { aliases: name }],
      type: 'city',
    }, { opgId: 1 }).lean();

    const existing = await CrawlSeed.findOne({ cityName: name, deletedAt: null }).lean();
    if (existing) continue;

    await CrawlSeed.create({
      locationOpgId: loc?.opgId || null,
      cityName:      name,
      categorySlugs: [],  // will use all taxonomy entries if empty
      priority:      city.priority || 5,
      frequency:     mappedFreq,
      nextSeedAt:    new Date(),
      isEnabled:     true,
    });
    created++;
  }

  logger.info(`[SeedService] Migrated ${created} seeds from schedule.json`);
  return created;
}

module.exports = { getNextBatch, upsertSeed, recordRun, migrateSeedsFromScheduleConfig, assignFrequency };
