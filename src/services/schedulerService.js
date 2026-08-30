'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const logger = require('../utils/logger');
const CrawlJob = require('../db/crawlJobModel');
const Space = require('../db/spaceModel');
const { addCityJob, addSpaceNameJob } = require('../queue/queues');
const { FITNESS_CATEGORIES } = require('../scraper/googleMapsScraper');
const bus = require('./eventBus');
const { runPhotoSync } = require('./photoSyncService');

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

async function queueStaleSpaces(reason = 'staleness-check') {
  const config = getScheduleConfig();
  const settings = config.staleness || {};
  const thresholdDays = settings.enrichmentThresholdDays || 30;
  const maxStale = settings.maxStaleDays || 90;
  const batchSize = settings.batchSize || 50;

  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000);

  // Read from new crawl mirror first; fall back to legacy crawlMeta.
  const staleSpaces = await Space.aggregate([
    { $match: { permanentlyClosed: { $ne: true } } },
    {
      $addFields: {
        effectiveLastCrawledAt: { $ifNull: ['$crawl.lastCrawledAt', '$crawlMeta.lastCrawledAt'] },
      },
    },
    {
      $match: {
        $or: [
          { effectiveLastCrawledAt: { $lt: cutoff } },
          { effectiveLastCrawledAt: { $exists: false } },
          { effectiveLastCrawledAt: null },
        ],
      },
    },
    { $sort: { effectiveLastCrawledAt: 1 } },
    { $limit: batchSize },
    { $project: { name: 1, areaName: 1, slug: 1, effectiveLastCrawledAt: 1 } },
  ]);

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
      await CrawlJob.create({ jobId, type: 'space_name', input: { spaceName }, status: 'queued' });
      await addSpaceNameJob(jobId, spaceName);
      queued.push({ spaceName, jobId });
    } catch (err) {
      logger.error(`  ❌ Failed to queue stale space "${spaceName}": ${err.message}`);
    }
  }

  logger.info(`📅 Staleness: ${queued.length} stale spaces queued for re-crawl\n`);
  return queued;
}

// ── Enrichment: re-crawl incomplete spaces ─────────────────────────────────────

async function queueIncompleteSpaces(reason = 'enrichment') {
  const config = getScheduleConfig();
  const settings = config.enrichment || {};

  if (!settings.enabled) return [];

  const threshold = settings.completenessThreshold || 60;
  const batchSize = settings.batchSize || 30;

  const incomplete = await Space.aggregate([
    { $match: { permanentlyClosed: { $ne: true } } },
    {
      $addFields: {
        effectiveCompleteness: { $ifNull: ['$crawl.dataCompleteness', '$crawlMeta.dataCompleteness'] },
      },
    },
    {
      $match: {
        $or: [
          { effectiveCompleteness: { $lt: threshold } },
          { effectiveCompleteness: { $exists: false } },
          { effectiveCompleteness: null },
        ],
      },
    },
    { $sort: { effectiveCompleteness: 1 } },
    { $limit: batchSize },
    { $project: { name: 1, areaName: 1, effectiveCompleteness: 1 } },
  ]);

  if (!incomplete.length) {
    logger.info(`📅 Enrichment: all spaces above ${threshold}% completeness`);
    return [];
  }

  logger.info(`\n📅 Enrichment [${reason}] — ${incomplete.length} spaces below ${threshold}% completeness`);

  const queued = [];
  for (const g of incomplete) {
    const spaceName = `${g.name} ${g.areaName || ''}`.trim();
    const jobId = uuidv4();
    try {
      await CrawlJob.create({ jobId, type: 'space_name', input: { spaceName }, status: 'queued' });
      await addSpaceNameJob(jobId, spaceName);
      queued.push({ spaceName, jobId, completeness: g.effectiveCompleteness || 0 });
    } catch (err) {
      logger.error(`  ❌ Failed to queue enrichment for "${spaceName}": ${err.message}`);
    }
  }

  logger.info(`📅 Enrichment: ${queued.length} incomplete spaces queued\n`);
  return queued;
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
    await queueStaleSpaces('staleness-cron');
  }, { timezone: tz });

  // Enrichment: Every Friday at 03:00 AM IST = 21:30 UTC Thursday
  cron.schedule('30 21 * * 4', async () => {
    await queueIncompleteSpaces('enrichment-cron');
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

  logger.info('⏰ Scheduler started:');
  logger.info('   • Weekly cities    → every Sunday 02:00 AM IST');
  logger.info('   • Biweekly cities  → 1st & 3rd Sunday 03:00 AM IST');
  logger.info('   • Monthly cities   → 1st Sunday 04:00 AM IST');
  logger.info('   • Staleness check  → every Wednesday 03:00 AM IST');
  logger.info('   • Enrichment       → every Friday 03:00 AM IST');
  logger.info('   • Photo sync       → every day 04:00 AM IST');
}

module.exports = {
  startScheduler,
  scheduleNCRCrawl,
  runScheduledCrawl,
  queueStaleSpaces,
  queueIncompleteSpaces,
  getScheduleConfig,
  saveScheduleConfig,
  queueCity,
};
