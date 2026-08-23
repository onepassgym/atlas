'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const logger = require('../utils/logger');
const CrawlJob = require('../db/crawlJobModel');
const Space = require('../db/spaceModel');
const { addCityJob, addGymNameJob } = require('../queue/queues');
const { FITNESS_CATEGORIES } = require('../scraper/googleMapsScraper');
const bus = require('./eventBus');
const { runPhotoSync } = require('./photoSyncService');
const { getNextBatch, recordRun } = require('./seedService');
const { discover }    = require('./discoveryService');
const { processDiscoveryCandidates } = require('./discoveryProcessor');

const SCHEDULE_PATH = path.resolve(__dirname, '../../config/schedule.json');

// ── Load schedule config ─────────────────────────────────────────────────────

function getScheduleConfig() {
  try {
    if (fs.existsSync(SCHEDULE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
      // Support both old format (plain array) and new format (object)
      if (Array.isArray(raw)) {
        return {
          defaultFrequency: 'weekly',
          defaultCron: '30 20 * * 6',
          timezone: 'UTC',
          cities: raw.map(c => ({ name: typeof c === 'string' ? c : c.city || c.name, frequency: 'weekly', priority: 3 })),
          staleness: { enrichmentThresholdDays: 30, maxStaleDays: 90, batchSize: 50 },
          enrichment: { enabled: true, completenessThreshold: 60, batchSize: 30 },
        };
      }
      return raw;
    }
  } catch (e) {
    logger.error('Failed to read schedule.json:', e.message);
  }
  return { cities: [], staleness: {}, enrichment: {} };
}

function saveScheduleConfig(config) {
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(config, null, 2));
}

// ── Job dedup helper ─────────────────────────────────────────────────────────

async function hasActiveJobForCity(cityName) {
  return CrawlJob.findOne({
    'input.cityName': { $regex: new RegExp(`^${cityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    status: { $in: ['queued', 'running'] },
  }).lean();
}

// ── Queue a single city (with dedup check) ───────────────────────────────────

async function queueCity(cityName, reason = 'scheduled') {
  const existing = await hasActiveJobForCity(cityName);
  if (existing) {
    logger.info(`  ⏭  Skipped "${cityName}" — already ${existing.status} (${existing.jobId})`);
    return null;
  }

  const jobId = uuidv4();
  await CrawlJob.create({
    jobId,
    type: 'city',
    input: { cityName, categories: FITNESS_CATEGORIES },
    status: 'queued',
  });
  await addCityJob(jobId, cityName, FITNESS_CATEGORIES);
  logger.info(`  ✅ Queued: ${cityName} → ${jobId} [${reason}]`);
  return jobId;
}

// ── Scheduled crawl by frequency ─────────────────────────────────────────────

async function runScheduledCrawl(frequency, reason = 'cron') {
  const config = getScheduleConfig();
  const cities = (config.cities || []).filter(c => c.frequency === frequency);

  if (!cities.length) {
    logger.info(`📅 No cities scheduled for frequency "${frequency}"`);
    return [];
  }

  logger.info(`\n📅 Scheduled crawl [${reason}] — frequency: ${frequency}, ${cities.length} cities`);

  const queued = [];
  for (const city of cities) {
    const jobId = await queueCity(city.name, `${frequency}-${reason}`);
    if (jobId) queued.push({ cityName: city.name, jobId });
  }

  logger.info(`📅 Scheduled: ${queued.length} queued, ${cities.length - queued.length} skipped (already active)\n`);
  bus.publish('schedule:fired', { frequency, reason, count: queued.length, skipped: cities.length - queued.length });
  return queued;
}

// ── Staleness-aware re-crawl ─────────────────────────────────────────────────
// Finds spaces that haven't been crawled for >N days and queues them for refresh.

async function queueStaleGyms(reason = 'staleness-check') {
  const config = getScheduleConfig();
  const settings = config.staleness || {};
  const thresholdDays = settings.enrichmentThresholdDays || 30;
  const batchSize = settings.batchSize || 50;

  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000);

  // Find spaces crawled more than N days ago, sorted oldest first
  const staleSpaces = await Space.find({
    deletedAt: null,
    $or: [
      { 'crawl.lastCrawledAt': { $lt: cutoff } },
      { 'crawl.lastCrawledAt': { $exists: false } },
    ],
  })
    .select('name areaName slug crawl.lastCrawledAt')
    .sort({ 'crawl.lastCrawledAt': 1 })
    .limit(batchSize)
    .lean();

  if (!staleSpaces.length) {
    logger.info(`📅 Staleness check: all spaces are fresh (< ${thresholdDays} days)`);
    return [];
  }

  logger.info(`\n📅 Staleness check [${reason}] — found ${staleSpaces.length} stale spaces (> ${thresholdDays} days)`);

  const queued = [];
  for (const g of staleSpaces) {
    const spaceName = `${g.name} ${g.areaName || ''}`.trim();
    const jobId = uuidv4();
    try {
      await CrawlJob.create({ jobId, type: 'gym_name', input: { gymName: spaceName }, status: 'queued' });
      await addGymNameJob(jobId, spaceName);
      queued.push({ spaceName, jobId });
    } catch (err) {
      logger.error(`  ❌ Failed to queue stale space "${spaceName}": ${err.message}`);
    }
  }

  logger.info(`📅 Staleness: ${queued.length} stale spaces queued for re-crawl\n`);
  return queued;
}

// ── Enrichment: re-crawl incomplete gyms ─────────────────────────────────────

async function queueIncompleteGyms(reason = 'enrichment') {
  const config = getScheduleConfig();
  const settings = config.enrichment || {};

  if (!settings.enabled) return [];

  const batchSize = settings.batchSize || 30;
  const Location = require('../db/locationModel');
  const { addEnrichmentJob } = require('../queue/queues');

  // Phase 2: Smart selection — prioritize by (isServiceable city) × (low completeness) × (staleness)
  // Exclude quarantined spaces (consecutiveErrors >= 5)
  const QUARANTINE_THRESHOLD = 5;
  const STALE_DAYS = 14;
  const staleCutoff = new Date(Date.now() - STALE_DAYS * 86_400_000);

  // Get serviceable city opgIds for priority boost
  const serviceableCities = await Location.find(
    { type: 'city', isServiceable: true },
    { opgId: 1 }
  ).lean();
  const serviceableCityIds = new Set(serviceableCities.map(c => c.opgId));

  // Find candidates: not quarantined, not deleted, has a googleMapsUrl to enrich
  const candidates = await Space.find({
    deletedAt: null,
    googleMapsUrl: { $exists: true, $ne: null },
    'enrichment.status': { $ne: 'quarantined' },
    'enrichment.consecutiveErrors': { $lt: QUARANTINE_THRESHOLD },
    $or: [
      { dataCompleteness: { $lt: 80 } },
      { 'enrichment.lastSuccess': { $lt: staleCutoff } },
      { 'enrichment.lastSuccess': null },
    ],
  })
    .select('name areaName city cityOpgId googleMapsUrl dataCompleteness enrichment.lastSuccess enrichment.consecutiveErrors')
    .limit(batchSize * 3) // over-fetch to score and pick top N
    .lean();

  if (!candidates.length) {
    logger.info(`📅 Enrichment: no eligible spaces found`);
    return [];
  }

  // Score each candidate: higher score = higher priority
  const scored = candidates.map(s => {
    const isServiceable = serviceableCityIds.has(s.cityOpgId) ? 2.0 : 1.0;
    const completenessGap = (100 - (s.dataCompleteness || 0)) / 100; // 0-1
    const lastEnriched = s.enrichment?.lastSuccess;
    const daysSinceEnriched = lastEnriched
      ? (Date.now() - new Date(lastEnriched).getTime()) / 86_400_000
      : 999; // never enriched = max staleness
    const stalenessScore = Math.min(daysSinceEnriched / 30, 3.0); // caps at 3x
    return { ...s, score: isServiceable * completenessGap * stalenessScore };
  });

  // Sort by score descending, take top batchSize
  scored.sort((a, b) => b.score - a.score);
  const toEnrich = scored.slice(0, batchSize);

  logger.info(`\n📅 Enrichment [${reason}] — ${toEnrich.length} spaces selected (from ${candidates.length} candidates, scored by serviceable×completeness×staleness)`);

  const queued = [];
  for (const s of toEnrich) {
    try {
      await addEnrichmentJob(s._id, s.googleMapsUrl, s.city || s.areaName);
      queued.push({ name: s.name, spaceId: String(s._id), completeness: s.dataCompleteness, score: s.score.toFixed(2) });
    } catch (err) {
      logger.error(`  ❌ Failed to queue enrichment for "${s.name}": ${err.message}`);
    }
  }

  logger.info(`📅 Enrichment: ${queued.length} spaces queued for enrichment\n`);
  bus.publish('enrichment:batch-queued', { reason, count: queued.length, candidatesConsidered: candidates.length });
  return queued;
}

// ── Seed-based crawl (DB-driven, replaces schedule.json iteration over time) ──

async function runSeedBasedCrawl(reason = 'seed-cron') {
  const seeds = await getNextBatch(20);
  if (!seeds.length) {
    logger.info('📅 Seed crawl: no seeds due for crawl');
    return [];
  }

  logger.info(`\n📅 Seed crawl [${reason}] — ${seeds.length} seeds due`);
  const results = [];

  for (const seed of seeds) {
    try {
      // Phase 7A: multi-source discovery → entity pipeline (OSM + JustDial + Google Maps)
      const { candidates, crawlRunId } = await discover({
        locationOpgId: seed.locationOpgId,
        cityName:      seed.cityName,
        categorySlugs: seed.categorySlugs?.length ? seed.categorySlugs : null,
      });

      let processingStats = { created: 0, updated: 0, skipped: 0, needsReview: 0, errors: 0 };

      if (candidates.length > 0) {
        processingStats = await processDiscoveryCandidates(candidates, seed.locationOpgId, crawlRunId);
      }

      // Also queue a BullMQ city job for deep Google Maps detail scraping
      const jobId = await queueCity(seed.cityName, `seed-${reason}`);

      await recordRun(seed._id, {
        recordsFound: candidates.length,
        googleBlocked: false,
      });

      results.push({ cityName: seed.cityName, jobId, candidates: candidates.length, ...processingStats });
      logger.info(`  ✅ Seed "${seed.cityName}": ${candidates.length} candidates → ${processingStats.created} new, ${processingStats.updated} updated`);

    } catch (err) {
      logger.error(`  ❌ Seed crawl failed for "${seed.cityName}": ${err.message}`);
      await recordRun(seed._id, { recordsFound: 0, googleBlocked: /block|captcha/i.test(err.message) });
    }
  }

  bus.publish('schedule:fired', { reason, count: results.length });
  return results;
}

// ── Trigger all scheduled cities (legacy compat) ─────────────────────────────

async function scheduleNCRCrawl(reason = 'scheduled') {
  const config = getScheduleConfig();
  const cities = config.cities || [];

  logger.info(`\n📅 Scheduled crawl triggered [${reason}] — queuing ${cities.length} cities`);

  const queued = [];
  for (const city of cities) {
    const cityName = typeof city === 'string' ? city : city.name;
    const jobId = await queueCity(cityName, reason);
    if (jobId) queued.push({ cityName, jobId });
  }

  logger.info(`📅 Scheduled crawl: ${queued.length} queued.\n`);
  return queued;
}

// ── Start all cron schedules ─────────────────────────────────────────────────

function startScheduler() {
  const config = getScheduleConfig();
  const tz = config.timezone || 'UTC';

  // Weekly: Every Sunday 02:00 AM IST = 20:30 UTC Saturday
  cron.schedule('30 20 * * 6', async () => {
    await runScheduledCrawl('weekly', 'weekly-cron');
  }, { timezone: tz });

  // Biweekly: 1st and 3rd Sunday of month at 03:00 AM IST = 21:30 UTC Saturday
  cron.schedule('30 21 * * 6', async () => {
    const day = new Date().getUTCDate();
    // Runs on 1st-7th and 15th-21st (approximates 1st and 3rd week)
    if (day <= 7 || (day >= 15 && day <= 21)) {
      await runScheduledCrawl('biweekly', 'biweekly-cron');
    }
  }, { timezone: tz });

  // Monthly: 1st Sunday of month at 04:00 AM IST = 22:30 UTC Saturday
  cron.schedule('30 22 * * 6', async () => {
    const day = new Date().getUTCDate();
    if (day <= 7) {
      await runScheduledCrawl('monthly', 'monthly-cron');
    }
  }, { timezone: tz });

  // Staleness check: Every Wednesday at 03:00 AM IST = 21:30 UTC Tuesday
  cron.schedule('30 21 * * 2', async () => {
    await queueStaleGyms('staleness-cron');
  }, { timezone: tz });

  // Enrichment: Every Friday at 03:00 AM IST = 21:30 UTC Thursday
  cron.schedule('30 21 * * 4', async () => {
    await queueIncompleteGyms('enrichment-cron');
  }, { timezone: tz });

  // Photo sync: Every day at 4:00 AM IST = 22:30 UTC previous day
  cron.schedule('30 22 * * *', async () => {
    logger.info('[scheduler] Triggering nightly photo sync (4 AM IST)...');
    try {
      await runPhotoSync('cron');
    } catch (e) {
      logger.error(`[scheduler] Photo sync cron failed: ${e.message}`);
    }
  }, { timezone: tz });

  // Seed-based crawl: every 6 hours — picks seeds due by nextSeedAt
  cron.schedule('0 */6 * * *', async () => {
    await runSeedBasedCrawl('seed-6h-cron');
  }, { timezone: tz });

  // Idle feeder: checks every minute if the crawler is free and feeds due seeds
  cron.schedule('* * * * *', async () => {
    try {
      const { getQueueStats } = require('../queue/queues');
      const stats = await getQueueStats();
      if (stats.waiting === 0 && stats.active === 0 && stats.delayed === 0) {
        const { getNextBatch } = require('./seedService');
        const due = await getNextBatch(1);
        if (due.length > 0) {
          logger.info(`[scheduler] Crawler is idle. Triggering next batch of scheduled seeds...`);
          await runSeedBasedCrawl('idle-feeder');
        }
      }
    } catch (e) {
      logger.error(`[scheduler] Idle feeder failed: ${e.message}`);
    }
  }, { timezone: tz });

  // opg-core sync: every night at 1:00 AM IST = 19:30 UTC previous day
  cron.schedule('30 19 * * *', async () => {
    logger.info('[scheduler] Triggering nightly opg-core sync...');
    try {
      const { syncBatch } = require('./syncService');
      const result = await syncBatch(200);
      logger.info(`[scheduler] Sync complete: ${result.synced} synced, ${result.archived} archived`);
    } catch (e) {
      logger.error(`[scheduler] opg-core sync failed: ${e.message}`);
    }
  }, { timezone: tz });

  logger.info('⏰ Scheduler started:');
  logger.info('   • Weekly cities    → every Sunday 02:00 AM IST');
  logger.info('   • Biweekly cities  → 1st & 3rd Sunday 03:00 AM IST');
  logger.info('   • Monthly cities   → 1st Sunday 04:00 AM IST');
  logger.info('   • Staleness check  → every Wednesday 03:00 AM IST');
  logger.info('   • Enrichment       → every Friday 03:00 AM IST');
  logger.info('   • Photo sync       → every day 04:00 AM IST');
  logger.info('   • Seed-based crawl → every 6h (DB-driven seeds)');
  logger.info('   • Idle feeder      → every minute (if queue empty)');
  logger.info('   • opg-core sync    → every night 01:00 AM IST');
}

module.exports = {
  startScheduler,
  scheduleNCRCrawl,
  runScheduledCrawl,
  runSeedBasedCrawl,
  queueStaleGyms,
  queueIncompleteGyms,
  getScheduleConfig,
  saveScheduleConfig,
  queueCity,
};
