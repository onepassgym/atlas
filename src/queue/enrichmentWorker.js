'use strict';

/**
 * enrichmentWorker.js — Continuous Enrichment Loop Worker
 *
 * Runs as a standalone process (npm run worker:enrich) that:
 *   1. Checks for priority space IDs in the Redis priority queue
 *   2. If none, picks the oldest-updated space from MongoDB
 *   3. Opens browser, re-scrapes the space's Google Maps page
 *   4. Updates the space document with enriched data
 *   5. Sleeps briefly, then repeats
 *
 * Respects pause/resume flag — when paused, polls every 5s until resumed.
 */

require('dotenv').config();

const { connectDB } = require('../db/connection');
const Space = require('../db/spaceModel');
const SystemState = require('../db/systemStateModel');
const EnrichmentLog = require('../db/enrichmentLogModel');
const { BrowserManager, scrapeSpaceDetail, scrapeSelective } = require('../scraper/googleMapsScraper');
const { scrapeWebsitePhotos } = require('../scraper/websiteScraper');
const { processSpace } = require('../scraper/spaceProcessor');
const {
  isPaused,
  popPrioritySpace,
  setStatus,
  getStatus,
} = require('../services/enrichmentService');
const cfg = require('../../config');
const logger = require('../utils/logger');
const bus = require('../services/eventBus');

const DELAY_BETWEEN_SPACES = parseInt(process.env.ENRICHMENT_DELAY || '3000', 10);
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
 * Get the next space to enrich:
 *   1. Priority queue (Redis) — specific space requested by user
 *   2. Oldest updatedAt space from MongoDB (FIFO enrichment)
 */
async function getNextSpace() {
  // 1. Check priority queue
  const priority = await popPrioritySpace();
  if (priority) {
    const space = await Space.findById(priority.spaceId).lean();
    if (space) {
      return { space, source: 'priority', spaceName: priority.spaceName, sections: priority.sections || ['all'] };
    }
    logger.warn(`Priority space ${priority.spaceId} not found in DB — skipping`);
  }

  // 2. Pick oldest-updated space that isn't permanently closed
  const space = await Space.findOne({
    permanentlyClosed: { $ne: true },
    googleMapsUrl: { $exists: true, $ne: null },
  })
    .sort({ updatedAt: 1 })  // Oldest update first = FIFO
    .select('_id name slug areaName googleMapsUrl updatedAt')
    .lean();

  return space ? { space, source: 'queue', sections: ['all'] } : null;
}

/**
 * Enrich a single space by re-scraping its Google Maps page.
 */
async function enrichSpace(browser, space, source, sections = ['all']) {
  const startTime = Date.now();
  const spaceName = space.name || 'Unknown';
  const spaceId = space._id.toString();
  const isSelective = !sections.includes('all') && !sections.includes('deep');
  const sectionLabel = isSelective ? sections.join(', ') : (sections.includes('deep') ? 'deep' : 'full');

  bus.publish('enrichment:space-start', {
    spaceId,
    spaceName,
    source,
    sections,
    url: space.googleMapsUrl,
    updatedAt: space.updatedAt,
  });

  logger.info(`  🔄 Enriching: ${spaceName} [${source}] [${sectionLabel}] (last updated: ${space.updatedAt ? new Date(space.updatedAt).toLocaleDateString() : 'never'})`);

  const page = await browser.newPage();

  try {
    // Use selective scraper for targeted sections, full scraper otherwise
    const scraped = isSelective
      ? await scrapeSelective(page, space.googleMapsUrl, sections)
      : await scrapeSpaceDetail(page, space.googleMapsUrl, sections.includes('deep') ? 'deep' : 'standard');

    if (!scraped?.name) {
      throw new Error('Could not extract space data from page');
    }

    // ── Multi-Source Data Fusion: Extract supplementary photos from official website
    const websiteUrl = scraped.website || space.contact?.website;
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
    const result = await processSpace(scraped, space.areaName || '', `enrich:${spaceId}`, true);
    const duration = Date.now() - startTime;

    // ── Update Space Meta ──
    try {
      await Space.findByIdAndUpdate(spaceId, {
        $set: {
          'enrichmentMeta.lastAttempt': new Date(startTime),
          'enrichmentMeta.lastSuccess': new Date(),
          'enrichmentMeta.status': 'success',
          'enrichmentMeta.consecutiveErrors': 0,
          'enrichmentMeta.error': null,
        }
      });
    } catch (e) { logger.warn(`Failed to update space meta for ${spaceId}: ${e.message}`); }

    // ── Create History Log ──
    try {
      await EnrichmentLog.create({
        spaceId,
        spaceName: scraped.name,
        status: 'success',
        durationMs: duration,
        startedAt: new Date(startTime),
        finishedAt: new Date(),
        fieldsUpdated: result.changedFields || [],
        photosAdded: result.newPhotos || 0,
        reviewsAdded: result.newReviews || 0
      });
    } catch (e) { logger.warn(`Failed to create enrichment log for ${spaceId}: ${e.message}`); }

    processedTotal++;
    processedToday++;

    bus.publish('enrichment:space-done', {
      spaceId,
      spaceName: scraped.name,
      source,
      action: result.action,
      duration,
    });

    logger.info(`  ✅ Enriched: ${scraped.name} → ${result.action} (${(duration / 1000).toFixed(1)}s)`);

    return { success: true, action: result.action, duration };
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.warn(`  ❌ Enrichment failed for "${spaceName}": ${err.message}`);

    // ── Update Space Meta (Fail) ──
    try {
      await Space.findByIdAndUpdate(spaceId, {
        $set: {
          'enrichmentMeta.lastAttempt': new Date(startTime),
          'enrichmentMeta.status': 'failed',
          'enrichmentMeta.error': err.message,
        },
        $inc: { 'enrichmentMeta.consecutiveErrors': 1 }
      });
    } catch (e) { logger.warn(`Failed to update space fail meta for ${spaceId}: ${e.message}`); }

    // ── Create History Log (Fail) ──
    try {
      await EnrichmentLog.create({
        spaceId,
        spaceName,
        status: 'failed',
        error: err.message,
        durationMs: duration,
        startedAt: new Date(startTime),
        finishedAt: new Date(),
      });
    } catch (e) { logger.warn(`Failed to create enrichment fail log for ${spaceId}: ${e.message}`); }

    bus.publish('enrichment:space-failed', {
      spaceId,
      spaceName,
      error: err.message.slice(0, 120),
      duration,
    });

    // Touch updatedAt so this space goes to the back of the queue
    try {
      await Space.findByIdAndUpdate(space._id, { $set: { updatedAt: new Date() } });
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
  logger.info(`   • Delay between spaces: ${DELAY_BETWEEN_SPACES}ms`);
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

    // ── Get next space ─────────────────────────────────────────────────────
    const next = await getNextSpace();
    if (!next) {
      logger.info('  💤 No spaces to enrich — sleeping 30s...');
      await setStatus({ state: 'idle', processedTotal, processedToday });
      await sleep(30000);
      continue;
    }

    // ── Ensure browser is running ────────────────────────────────────────
    if (!browser) {
      browser = new BrowserManager();
      await browser.launch();
    }

    // ── Enrich the space ───────────────────────────────────────────────────
    const result = await enrichSpace(browser, next.space, next.source, next.sections);

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
      lastSpace: next.space.name,
      lastAction: result.action || 'failed',
      lastDuration: result.duration,
    });

    // ── Inter-space delay (human-like) ─────────────────────────────────────
    await randomDelay(DELAY_BETWEEN_SPACES, DELAY_BETWEEN_SPACES * 1.5);
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
