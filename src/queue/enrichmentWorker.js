'use strict';

/**
 * enrichmentWorker.js — Continuous Enrichment Loop Worker
 *
 * Runs as a standalone process (npm run worker:enrich) that:
 *   1. Checks for priority gym IDs in the Redis priority queue
 *   2. If none, picks the oldest-updated gym from MongoDB
 *   3. Opens browser, re-scrapes the gym's Google Maps page
 *   4. Updates the gym document with enriched data
 *   5. Sleeps briefly, then repeats
 *
 * Respects pause/resume flag — when paused, polls every 5s until resumed.
 */

require('dotenv').config();

const { connectDB } = require('../db/connection');
const Space = require('../db/spaceModel');
const SystemState = require('../db/systemStateModel');
const EnrichmentLog = require('../db/enrichmentLogModel');
const { BrowserManager, scrapeGymDetail, scrapeSelective } = require('../scraper/googleMapsScraper');
const { scrapeWebsitePhotos } = require('../scraper/websiteScraper');
const { processGym } = require('../scraper/gymProcessor');
const {
  isPaused,
  popPrioritySpace,
  setStatus,
  getStatus,
} = require('../services/enrichmentService');
const cfg = require('../../config');
const logger = require('../utils/logger');
const bus = require('../services/eventBus');

const DELAY_BETWEEN_GYMS = parseInt(process.env.ENRICHMENT_DELAY || '3000', 10);
const PAUSE_POLL_INTERVAL = 5000;
const BATCH_SIZE = parseInt(process.env.ENRICHMENT_BATCH_SIZE || '10', 10);
const MAX_ERRORS_BEFORE_COOLDOWN = 5;

let isShuttingDown = false;
let processedTotal = 0;
let processedToday = 0;
let todayDate = new Date().toISOString().slice(0, 10);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// Reset daily counter at midnight
function checkDayRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== todayDate) {
    todayDate = today;
    processedToday = 0;
  }
}

/**
 * Get the next gym to enrich:
 *   1. Priority queue (Redis) — specific gym requested by user
 *   2. Oldest updatedAt gym from MongoDB (FIFO enrichment)
 */
async function getNextGym() {
  // 1. Check priority queue
  const priority = await popPriorityGym();
  if (priority) {
    const gym = await Space.findById(priority.gymId).lean();
    if (gym) {
      return { gym, source: 'priority', gymName: priority.gymName, sections: priority.sections || ['all'] };
    }
    logger.warn(`Priority gym ${priority.gymId} not found in DB — skipping`);
  }

  // 2. Pick oldest-updated gym that isn't permanently closed
  const gym = await Space.findOne({
    permanentlyClosed: { $ne: true },
    googleMapsUrl: { $exists: true, $ne: null },
  })
    .sort({ updatedAt: 1 })  // Oldest update first = FIFO
    .select('_id name slug areaName googleMapsUrl updatedAt')
    .lean();

  return gym ? { gym, source: 'queue', sections: ['all'] } : null;
}

/**
 * Enrich a single gym by re-scraping its Google Maps page.
 */
async function enrichGym(browser, gym, source, sections = ['all']) {
  const startTime = Date.now();
  const gymName = gym.name || 'Unknown';
  const gymId = gym._id.toString();
  const isSelective = !sections.includes('all') && !sections.includes('deep');
  const sectionLabel = isSelective ? sections.join(', ') : (sections.includes('deep') ? 'deep' : 'full');

  bus.publish('enrichment:gym-start', {
    gymId,
    gymName,
    source,
    sections,
    url: gym.googleMapsUrl,
    updatedAt: gym.updatedAt,
  });

  logger.info(`  🔄 Enriching: ${gymName} [${source}] [${sectionLabel}] (last updated: ${gym.updatedAt ? new Date(gym.updatedAt).toLocaleDateString() : 'never'})`);

  const page = await browser.newPage();

  try {
    // Use selective scraper for targeted sections, full scraper otherwise
    const scraped = isSelective
      ? await scrapeSelective(page, gym.googleMapsUrl, sections)
      : await scrapeGymDetail(page, gym.googleMapsUrl, sections.includes('deep') ? 'deep' : 'standard');

    if (!scraped?.name) {
      throw new Error('Could not extract gym data from page');
    }

    // ── Multi-Source Data Fusion: Extract supplementary photos from official website
    const websiteUrl = scraped.website || gym.contact?.website;
    if (websiteUrl && sections.includes('photos') || sections.includes('all')) {
      try {
        const websitePhotos = await scrapeWebsitePhotos(page, websiteUrl);
        if (websitePhotos && websitePhotos.length > 0) {
          scraped.photoUrls = [...new Set([...(scraped.photoUrls || []), ...websitePhotos])];
        }
      } catch (siteErr) {
        logger.warn(`  ⚠ Failed to extract supplementary photos from ${websiteUrl}: ${siteErr.message}`);
      }
    }

    // Process and upsert the enriched data
    const result = await processGym(scraped, gym.areaName || '', `enrich:${gymId}`, true);
    const duration = Date.now() - startTime;

    // ── Update Gym Meta ──
    try {
      await Space.findByIdAndUpdate(gymId, {
        $set: {
          'enrichmentMeta.lastAttempt': new Date(startTime),
          'enrichmentMeta.lastSuccess': new Date(),
          'enrichmentMeta.status': 'success',
          'enrichmentMeta.consecutiveErrors': 0,
          'enrichmentMeta.error': null,
        }
      });
    } catch (e) { logger.warn(`Failed to update gym meta for ${gymId}: ${e.message}`); }

    // ── Create History Log ──
    try {
      await EnrichmentLog.create({
        gymId,
        gymName: scraped.name,
        status: 'success',
        durationMs: duration,
        startedAt: new Date(startTime),
        finishedAt: new Date(),
        fieldsUpdated: result.changedFields || [],
        photosAdded: result.newPhotos || 0,
        reviewsAdded: result.newReviews || 0
      });
    } catch (e) { logger.warn(`Failed to create enrichment log for ${gymId}: ${e.message}`); }

    processedTotal++;
    processedToday++;

    bus.publish('enrichment:gym-done', {
      gymId,
      gymName: scraped.name,
      source,
      action: result.action,
      duration,
    });

    logger.info(`  ✅ Enriched: ${scraped.name} → ${result.action} (${(duration / 1000).toFixed(1)}s)`);

    return { success: true, action: result.action, duration };
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.warn(`  ❌ Enrichment failed for "${gymName}": ${err.message}`);

    // ── Update Gym Meta (Fail) ──
    try {
      await Space.findByIdAndUpdate(gymId, {
        $set: {
          'enrichmentMeta.lastAttempt': new Date(startTime),
          'enrichmentMeta.status': 'failed',
          'enrichmentMeta.error': err.message,
        },
        $inc: { 'enrichmentMeta.consecutiveErrors': 1 }
      });
    } catch (e) { logger.warn(`Failed to update gym fail meta for ${gymId}: ${e.message}`); }

    // ── Create History Log (Fail) ──
    try {
      await EnrichmentLog.create({
        gymId,
        gymName,
        status: 'failed',
        error: err.message,
        durationMs: duration,
        startedAt: new Date(startTime),
        finishedAt: new Date(),
      });
    } catch (e) { logger.warn(`Failed to create enrichment fail log for ${gymId}: ${e.message}`); }

    bus.publish('enrichment:gym-failed', {
      gymId,
      gymName,
      error: err.message.slice(0, 120),
      duration,
    });

    // Touch updatedAt so this gym goes to the back of the queue
    try {
      await Space.findByIdAndUpdate(gym._id, { $set: { updatedAt: new Date() } });
    } catch (_) {}

    return { success: false, error: err.message, duration };
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function runLoop() {
  await connectDB();
  logger.info('\n🔁 Enrichment Worker started');
  logger.info(`   • Delay between gyms: ${DELAY_BETWEEN_GYMS}ms`);
  logger.info(`   • Batch size: ${BATCH_SIZE}`);
  logger.info(`   • Cooldown after ${MAX_ERRORS_BEFORE_COOLDOWN} errors\n`);

  await setStatus({
    state: 'running',
    startedAt: new Date().toISOString(),
    processedTotal: 0,
    processedToday: 0,
  });

  bus.publish('enrichment:started', { startedAt: new Date().toISOString() });

  let consecutiveErrors = 0;
  let browser = null;

  while (!isShuttingDown) {
    checkDayRollover();

    // ── Pause check ──────────────────────────────────────────────────────
    let sysState = await SystemState.getGlobalState().catch(() => ({ globalPause: false }));
    if (await isPaused() || sysState.globalPause) {
      if (browser) {
        await browser.close();
        browser = null;
      }
      await setStatus({
        state: 'paused',
        processedTotal,
        processedToday,
      });
      logger.info('  ⏸️  Enrichment paused — waiting for resume signal...');
      
      let loopPaused = true;
      while (loopPaused && !isShuttingDown) {
        await sleep(PAUSE_POLL_INTERVAL);
        sysState = await SystemState.getGlobalState().catch(() => ({ globalPause: false }));
        const enrichPaused = await isPaused();
        if (!enrichPaused && !sysState.globalPause) loopPaused = false;
      }
      
      if (isShuttingDown) break;
      logger.info('  ▶️  Enrichment resumed');
      await setStatus({ state: 'running', processedTotal, processedToday });
    }

    // ── Get next gym ─────────────────────────────────────────────────────
    const next = await getNextGym();
    if (!next) {
      logger.info('  💤 No gyms to enrich — sleeping 30s...');
      await setStatus({ state: 'idle', processedTotal, processedToday });
      await sleep(30000);
      continue;
    }

    // ── Ensure browser is running ────────────────────────────────────────
    if (!browser) {
      browser = new BrowserManager();
      await browser.launch();
    }

    // ── Enrich the gym ───────────────────────────────────────────────────
    const result = await enrichGym(browser, next.gym, next.source, next.sections);

    if (result.success) {
      consecutiveErrors = 0;
    } else {
      consecutiveErrors++;

      // If too many consecutive errors, restart browser + cooldown
      if (consecutiveErrors >= MAX_ERRORS_BEFORE_COOLDOWN) {
        logger.warn(`  🛑 ${consecutiveErrors} consecutive errors — restarting browser + 60s cooldown`);
        bus.publish('enrichment:cooldown', { errors: consecutiveErrors, cooldownMs: 60000 });

        if (browser) {
          await browser.close();
          browser = null;
        }
        await sleep(60000);
        consecutiveErrors = 0;
      }
    }

    // ── Update status ────────────────────────────────────────────────────
    await setStatus({
      state: 'running',
      processedTotal,
      processedToday,
      lastGym: next.gym.name,
      lastAction: result.action || 'failed',
      lastDuration: result.duration,
    });

    // ── Inter-gym delay (human-like) ─────────────────────────────────────
    await randomDelay(DELAY_BETWEEN_GYMS, DELAY_BETWEEN_GYMS * 1.5);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  if (browser) await browser.close();
  await setStatus({ state: 'stopped', processedTotal, processedToday });
  logger.info('👋 Enrichment Worker shut down gracefully.');
}

// ── Process startup ─────────────────────────────────────────────────────────

const shutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`\n⏳ Received ${signal} — stopping enrichment loop...`);
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

runLoop().catch(err => {
  logger.error('Enrichment Worker fatal error:', err);
  process.exit(1);
});
