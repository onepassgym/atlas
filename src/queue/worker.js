'use strict';
require('dotenv').config();

const { Worker } = require('bullmq');
const { connectDB }   = require('../db/connection');
const { BrowserManager, searchGymsInCity, searchGymsInGrid, scrapeGymDetail, scrapeEnrichmentDetail, FITNESS_CATEGORIES, isBlocked } = require('../scraper/googleMapsScraper');
const { processGym }  = require('../scraper/gymProcessor');
const { processEnrichmentJob } = require('../scraper/enrichmentProcessor');
const CrawlJob        = require('../db/crawlJobModel');
const Gym             = require('../db/spaceModel');
const SystemState     = require('../db/systemStateModel');
const { isJobCancelled, clearCancelFlag, addBatchScrapeJob, enrichmentQueue } = require('./queues');
const cfg             = require('../../config');
const logger          = require('../utils/logger');
const bus             = require('../services/eventBus');

const connection = {
  host:     cfg.redis.host,
  port:     cfg.redis.port,
  password: cfg.redis.password || undefined,
};

const CONCURRENCY       = cfg.scraper.concurrency;
const DELAY_MIN         = cfg.scraper.delayMin;
const DELAY_MAX         = cfg.scraper.delayMax;
const MAX_RETRIES       = cfg.scraper.maxRetries;
// Phase 2: parallel browser pages within a single job (detail scraping)
const PAGE_POOL         = cfg.scraper.pagePool;
// Phase 6: parallel browser pages for category search
const SEARCH_POOL       = cfg.scraper.searchPool;
// Phase 7: skip URLs already crawled within this many days (0 = disabled)
const SKIP_RECENT_DAYS  = cfg.scraper.skipRecentDays;
// Phase 9: how many URLs per batch-scrape job
const BATCH_SIZE        = cfg.scraper.batchSize;

// ── Graceful shutdown state ──────────────────────────────────────────────────
let isShuttingDown = false;

function sleep(min, max) {
  return new Promise(async (resolve) => {
    let state = await SystemState.getGlobalState().catch(() => ({ crawlPace: 'normal', globalPause: false }));
    
    // Hold while globally paused
    while (state.globalPause && !isShuttingDown) {
      await new Promise(r => setTimeout(r, 5000));
      state = await SystemState.getGlobalState().catch(() => ({ crawlPace: 'normal', globalPause: false }));
    }

    let paceMultiplier = 1;
    if (state.crawlPace === 'slow') paceMultiplier = 3;
    if (state.crawlPace === 'fast') paceMultiplier = 0.5;

    const waitMs = (min + Math.random() * (max - min)) * paceMultiplier;
    setTimeout(resolve, waitMs);
  });
}

async function updateJob(jobId, update) {
  try { await CrawlJob.findOneAndUpdate({ jobId }, update); } catch (_) {}
}

/**
 * Check if this job should stop — either due to worker shutdown or API cancellation.
 */
async function shouldStop(jobId) {
  if (isShuttingDown) return 'shutdown';
  try {
    if (await isJobCancelled(jobId)) return 'cancelled';
  } catch (_) {}
  return false;
}

// ── Adaptive Throttle System ───────────────────────────────────────────────────
// Dynamically adjusts inter-URL delay based on success/failure patterns.
// Starts moderate, speeds up when everything is working, slows way down
// when Google starts blocking.

class AdaptiveThrottle {
  constructor(baseMin, baseMax) {
    this.baseMin = baseMin;
    this.baseMax = baseMax;
    this.multiplier = 1.0;
    this.consecutiveSuccess = 0;
    this.consecutiveFails = 0;
  }

  onSuccess(jobId) {
    const prevMultiplier = this.multiplier;
    this.consecutiveSuccess++;
    this.consecutiveFails = 0;
    // Speed up slightly after 5+ consecutive successes (min multiplier 0.8)
    if (this.consecutiveSuccess >= 5) {
      this.multiplier = Math.max(0.8, this.multiplier - 0.05);
    }
    // Publish throttle change if multiplier shifted
    if (prevMultiplier !== this.multiplier && jobId) {
      bus.publish('crawl:throttle', { jobId, multiplier: this.multiplier, direction: 'faster', consecutiveSuccess: this.consecutiveSuccess });
    }
  }

  onFailure(isBlock = false, jobId = null) {
    const prevMultiplier = this.multiplier;
    this.consecutiveFails++;
    this.consecutiveSuccess = 0;
    if (isBlock) {
      // Google actively blocking — slam the brakes
      this.multiplier = 4.0;
    } else {
      // Progressive slowdown: 1.5× → 2× → 3× → 4×
      this.multiplier = Math.min(4.0, 1.5 + (this.consecutiveFails * 0.5));
    }
    // Publish throttle change
    if (jobId) {
      bus.publish('crawl:throttle', { jobId, multiplier: this.multiplier, direction: 'slower', reason: isBlock ? 'google_block' : 'failure', consecutiveFails: this.consecutiveFails });
    }
  }

  async wait() {
    const min = Math.round(this.baseMin * this.multiplier);
    const max = Math.round(this.baseMax * this.multiplier);
    await sleep(min, max);
  }

  get status() {
    return `${this.multiplier.toFixed(2)}x (ok:${this.consecutiveSuccess} fail:${this.consecutiveFails})`;
  }
}

// ── Phase 2: Parallel page pool URL processor ────────────────────────────────
/**
 * Processes a list of URLs using a pool of N parallel browser pages.
 * Each page picks the next available URL from a shared index (work-stealing).
 *
 * @param {BrowserManager} browser  - Active BrowserManager instance
 * @param {string[]}       urls     - Full list of URLs to process
 * @param {string}         jobId    - For cancellation checks and DB updates
 * @param {string}         cityName - City label for processGym
 * @param {object}         stats    - Shared stats object (mutated in place)
 * @param {object}         bullJob  - BullMQ job for progress updates
 * @param {string}         mode     - Scrape mode: 'fast' | 'standard' | 'deep'
 */
async function processUrlsWithPool(browser, urls, jobId, cityName, stats, bullJob, mode = 'standard') {
  const total = urls.length;
  let urlIndex = 0;
  let stopReason = false;
  const throttle = new AdaptiveThrottle(DELAY_MIN, DELAY_MAX);

  // Open N pages in parallel inside the shared browser context
  const poolSize = Math.min(PAGE_POOL, total);
  logger.info(`  🔀 Opening ${poolSize} parallel pages for ${total} URLs (throttle: ${DELAY_MIN}-${DELAY_MAX}ms)`);
  const pages = await Promise.all(
    Array.from({ length: poolSize }, () => browser.newPage())
  );

  // Track next human pause point per-pool (shared)
  let nextPauseAt = 5 + Math.floor(Math.random() * 4);  // First pause at URL 5-8

  /**
   * Worker function: each page keeps grabbing the next URL until exhausted
   * or a stop signal is received.
   */
  async function workerLoop(page) {
    while (true) {
      // Atomically claim the next URL index
      const idx = urlIndex++;
      if (idx >= total) break;

      const url = urls[idx];
      const urlShort = url.split('/maps/place/')[1]?.split('/')[0] || url.slice(-50);

      // Check cancellation before each URL
      const stop = await shouldStop(jobId);
      if (stop) { stopReason = stop; break; }

      // Human-like pause: every 5-8 URLs, take a random break
      if (idx > 0 && idx >= nextPauseAt) {
        const pauseMs = 5000 + Math.random() * 10000;
        logger.info(`  ☕ Human pause at URL ${idx}/${total}: ${(pauseMs/1000).toFixed(1)}s (throttle: ${throttle.status})`);
        bus.publish('crawl:human-pause', { jobId, pauseMs: Math.round(pauseMs), urlIndex: idx, total });
        await sleep(pauseMs, pauseMs + 1000);
        nextPauseAt = idx + 5 + Math.floor(Math.random() * 4);
      }

      await bullJob.updateProgress(25 + Math.floor((idx / total) * 75));

      // Publish gym-start event
      bus.publish('crawl:gym-start', { jobId, url: urlShort, urlIndex: idx, total });
      const gymStartTime = Date.now();

      let scraped = null;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try { scraped = await scrapeGymDetail(page, url, mode); break; }
        catch (err) {
          lastError = err;
          const isBlock = err.message.includes('Google blocked');
          logger.warn(`  ⚠  Attempt ${attempt}/${MAX_RETRIES} [${url.slice(-40)}]: ${err.message}`);
          bus.publish('crawl:gym-failed', { jobId, url: urlShort, error: err.message.slice(0, 120), attempt, maxRetries: MAX_RETRIES, isBlock });

          // If Google blocked us, add a MUCH longer backoff
          if (isBlock) {
            const cooldownMs = 30000 + Math.random() * 30000;
            logger.warn('  🛑 Google block detected — cooling down for 30-60s');
            bus.publish('crawl:block', { jobId, reason: err.message.slice(0, 80), cooldownMs: Math.round(cooldownMs) });
            throttle.onFailure(true, jobId);
            await sleep(30000, 60000);
          } else {
            await sleep(3000 * attempt, 5000 * attempt);
          }
        }
      }

      if (!scraped?.name) {
        stats.failed++;
        throttle.onFailure(false, jobId);
        await updateJob(jobId, {
          $inc: { 'progress.failed': 1, errorCount: 1 },
          $push: { jobErrors: { message: lastError?.message || 'Could not extract gym data', url, at: new Date() } },
        });

        // Adaptive backoff: if many consecutive failures, Google is likely blocking
        if (throttle.consecutiveFails >= 3) {
          logger.warn(`  🛑 ${throttle.consecutiveFails} consecutive failures — extended cooldown (throttle: ${throttle.status})`);
          await sleep(20000, 40000);
        } else {
          await throttle.wait();
        }
        continue;
      }

      // Success — let throttle speed up if appropriate
      throttle.onSuccess(jobId);
      const gymDuration = Date.now() - gymStartTime;
      bus.publish('crawl:gym-done', { jobId, gymName: scraped.name, url: urlShort, action: 'pending', duration: gymDuration });

      const res = await processGym(scraped, cityName, jobId, true);

      if (res.action === 'created') {
        stats.created++;
        await updateJob(jobId, { $inc: { 'progress.newGyms': 1, 'progress.scraped': 1 }, $push: { gymIds: res.gymId } });
        bus.publish('gym:created', { name: scraped.name, area: cityName, gymId: String(res.gymId) });
      }
      if (res.action === 'updated') {
        stats.updated++;
        await updateJob(jobId, { $inc: { 'progress.updatedGyms': 1, 'progress.scraped': 1 }, $push: { gymIds: res.gymId } });
        bus.publish('gym:updated', { name: scraped.name, area: cityName, gymId: String(res.gymId), changes: 1 });
      }
      if (res.action === 'skipped') { stats.skipped++; await updateJob(jobId, { $inc: { 'progress.skipped': 1 } }); }
      if (res.action === 'error')   {
        stats.failed++;
        await updateJob(jobId, {
          $inc: { 'progress.failed': 1, errorCount: 1 },
          $push: { jobErrors: { message: res.error || 'processGym error', url, at: new Date() } },
        });
      }

      // Adaptive inter-URL delay
      await throttle.wait();
    }
  }

  // Run all page workers concurrently
  await Promise.all(pages.map(page => workerLoop(page)));

  // Close all pages
  await Promise.all(pages.map(async (page) => { try { await page.close(); } catch (_) {} }));

  logger.info(`  📊 Batch complete — throttle final: ${throttle.status}`);
  return stopReason;
}

// ── Phase 6: Parallel category search ────────────────────────────────────────
/**
 * Opens SEARCH_POOL browser pages simultaneously and splits 'categories'
 * across them using work-stealing so all pages stay busy.
 * Returns a Set of unique gym URLs found across all categories.
 */
async function searchAllCategories(browser, cityName, categories, jobId, bullJob) {
  const cats    = Array.isArray(categories) ? categories : FITNESS_CATEGORIES;
  const allUrls = new Set();
  let catIndex  = 0;
  let stopReason = false;

  const poolSize = Math.min(SEARCH_POOL, cats.length);
  logger.info(`  🔍 Searching ${cats.length} categories with ${poolSize} parallel pages`);

  const pages = await Promise.all(
    Array.from({ length: poolSize }, () => browser.newPage())
  );

  async function searchLoop(page) {
    while (catIndex < cats.length) {
      const ci  = catIndex++;
      const cat = cats[ci];

      const stop = await shouldStop(jobId);
      if (stop) { stopReason = stop; break; }

      bus.publish('crawl:search-start', { jobId, cityName, category: cat, categoryIndex: ci, totalCategories: cats.length });
      try {
        const urls = await searchGymsInCity(page, cityName, cat);
        urls.forEach(u => allUrls.add(u));
        bus.publish('crawl:search-done', { jobId, cityName, category: cat, urlsFound: urls.length, totalUnique: allUrls.size });
        await bullJob.updateProgress(Math.floor(((ci + 1) / categories.length) * 25));
      } catch (err) {
        logger.warn(`Category "${cat}" failed: ${err.message}`);
        bus.publish('crawl:search-done', { jobId, cityName, category: cat, urlsFound: 0, error: err.message.slice(0, 80) });
      }
      await sleep(DELAY_MIN, DELAY_MAX);
    }
  }

  await Promise.all(pages.map(p => searchLoop(p)));
  await Promise.all(pages.map(p => p.close().catch(() => {})));

  return { allUrls, stopReason };
}

// ── Phase 7: Pre-filter URLs already crawled recently ────────────────────────
/**
 * Loads googleMapsUrl values for gyms in this city that were crawled
 * within SKIP_RECENT_DAYS. Removes those from the URL list so we
 * don't waste scrape time on unchanged gyms.
 */
async function preFilterUrls(urls, cityName) {
  if (!SKIP_RECENT_DAYS || SKIP_RECENT_DAYS <= 0) return [...urls];

  try {
    const cutoff = new Date(Date.now() - SKIP_RECENT_DAYS * 86_400_000);

    const recentGyms = await Gym.aggregate([
      {
        $match: {
          areaName: { $regex: new RegExp(cityName.split(',')[0].trim(), 'i') },
          googleMapsUrl: { $exists: true, $ne: null },
        },
      },
      {
        $addFields: {
          effectiveLastCrawledAt: { $ifNull: ['$crawl.lastCrawledAt', '$crawlMeta.lastCrawledAt'] },
        },
      },
      {
        $match: {
          effectiveLastCrawledAt: { $gte: cutoff },
        },
      },
      { $project: { googleMapsUrl: 1 } },
    ]);

    const knownUrls = new Set(
      recentGyms
        .map(g => g.googleMapsUrl)
        .filter(Boolean)
        .map(u => u.split('?')[0].split('/@')[0])
    );

    const fresh   = urls.filter(u => !knownUrls.has(u));
    const skipped = urls.length - fresh.length;

    if (skipped > 0) {
      logger.info(`  🔎 Pre-filter: skipping ${skipped}/${urls.length} recently-crawled URLs (within ${SKIP_RECENT_DAYS}d)`);
    }
    return fresh;
  } catch (err) {
    // Non-fatal — fall back to scraping all URLs
    logger.warn(`Pre-filter query failed (scraping all): ${err.message}`);
    return [...urls];
  }
}

// ── City crawl job handler (Phase 9: discovery-only → enqueue batches) ───────
//
// The city job no longer scrapes any gym details itself.
// It opens a browser, searches all categories (parallel), pre-filters URLs,
// splits them into BATCH_SIZE chunks, and enqueues each chunk as a separate
// 'batch-scrape' BullMQ job. Multiple worker replicas then pick up batches
// in parallel, giving true multi-container parallelism.

async function processCityJob(job) {
  const { jobId, input = {} } = job.data;
  const { cityName, mode = 'standard' } = input;
  // Ensure categories is an array. Default to export if missing or null.
  const categories = Array.isArray(input.categories) ? input.categories : FITNESS_CATEGORIES;
  const startTime = Date.now();

  await connectDB();
  await updateJob(jobId, { status: 'running', startedAt: new Date(), bullJobId: String(job.id) });
  bus.publish('job:started', { jobId, type: 'city', cityName, categories: categories.length, mode });

  const browser = new BrowserManager();
  let stopReason = false;

  try {
    await browser.launch();
    logger.info(`\n🏙  [DISCOVERY] ${cityName} — ${categories.length} categories, searchPool:${SEARCH_POOL}, batchSize:${BATCH_SIZE}`);

    // ── Phase 6: Parallel category search ─────────────────────────────────
    const { allUrls, stopReason: searchStop } = await searchAllCategories(
      browser, cityName, categories, jobId, job
    );
    if (searchStop) stopReason = searchStop;

    await browser.close();

    const discoveredTotal = allUrls.size;
    logger.info(`\n📋 Discovered ${discoveredTotal} unique URLs for ${cityName}`);

    // ── Phase 7: Pre-filter recently-crawled URLs ──────────────────────────
    const urlsToScrape = stopReason ? [] : await preFilterUrls([...allUrls], cityName);
    const total = urlsToScrape.length;
    const skippedPreFilter = discoveredTotal - total;

    await updateJob(jobId, { 
      'progress.total': discoveredTotal, 
      'progress.toScrape': total,
      $inc: { 'progress.skipped': skippedPreFilter }
    });

    if (total === 0 || stopReason) {
      const durationMs = Date.now() - startTime;
      const finalStatus = stopReason === 'cancelled' ? 'cancelled' : 'completed';
      if (stopReason === 'cancelled') await clearCancelFlag(jobId);
      await updateJob(jobId, { status: finalStatus, completedAt: new Date(), durationMs });
      bus.publish('job:completed', { jobId, cityName, status: finalStatus, batches: 0, durationMs });
      logger.info(`  ✅ Discovery done: ${total} URLs, 0 batches (${(durationMs/1000).toFixed(1)}s)`);
      return { jobId, discovered: discoveredTotal, toScrape: 0, batches: 0, status: finalStatus };
    }

    // ── Phase 9: Split into batches and enqueue ────────────────────────────
    const batches = [];
    for (let i = 0; i < urlsToScrape.length; i += BATCH_SIZE) {
      batches.push(urlsToScrape.slice(i, i + BATCH_SIZE));
    }

    logger.info(`  🔀 Splitting ${total} URLs into ${batches.length} batch jobs (${BATCH_SIZE} URLs each)`);

    for (let bi = 0; bi < batches.length; bi++) {
      await addBatchScrapeJob(jobId, cityName, batches[bi], bi, mode);
    }

    // Mark discovery phase as done — batch results update the job document
    await updateJob(jobId, { 'progress.batches': batches.length, 'progress.batchesDone': 0 });
    bus.publish('job:batches-queued', { jobId, cityName, batches: batches.length, totalUrls: total });

    const durationMs = Date.now() - startTime;
    logger.info(`  ✅ Discovery done: ${discoveredTotal} found, ${total} to scrape, ${batches.length} batches enqueued (${(durationMs/1000).toFixed(1)}s)`);

    return { jobId, discovered: discoveredTotal, toScrape: total, batches: batches.length, durationMs };

  } catch (err) {
    await browser.close();
    const durationMs = Date.now() - startTime;
    await updateJob(jobId, { status: 'failed', completedAt: new Date(), durationMs });
    bus.publish('job:failed', { jobId, cityName, error: err.message, durationMs });
    logger.error(`💥 Discovery FAILED [${cityName}]: ${err.message}`);
    throw err;
  }
}

async function searchAllCategoriesForGrid(browser, lat, lng, zoom, regionName, categories, jobId, bullJob) {
  const cats    = Array.isArray(categories) ? categories : FITNESS_CATEGORIES;
  const allUrls = new Set();
  let catIndex  = 0;
  let stopReason = false;

  const poolSize = Math.min(SEARCH_POOL, cats.length);
  logger.info(`  🔍 Grid Searching ${cats.length} categories with ${poolSize} parallel pages at [${lat}, ${lng}]`);

  const pages = await Promise.all(
    Array.from({ length: poolSize }, () => browser.newPage())
  );

  async function searchLoop(page) {
    while (catIndex < cats.length) {
      const ci  = catIndex++;
      const cat = cats[ci];

      const stop = await shouldStop(jobId);
      if (stop) { stopReason = stop; break; }

      bus.publish('crawl:search-start', { jobId, regionName, category: cat, categoryIndex: ci, totalCategories: cats.length });
      try {
        const urls = await searchGymsInGrid(page, lat, lng, zoom, cat);
        urls.forEach(u => allUrls.add(u));
        bus.publish('crawl:search-done', { jobId, regionName, category: cat, urlsFound: urls.length, totalUnique: allUrls.size });
        await bullJob.updateProgress(Math.floor(((ci + 1) / categories.length) * 25));
      } catch (err) {
        logger.warn(`Category "${cat}" failed at [${lat}, ${lng}]: ${err.message}`);
        bus.publish('crawl:search-done', { jobId, regionName, category: cat, urlsFound: 0, error: err.message.slice(0, 80) });
      }
      await sleep(DELAY_MIN, DELAY_MAX);
    }
  }

  await Promise.all(pages.map(p => searchLoop(p)));
  await Promise.all(pages.map(p => p.close().catch(() => {})));

  return { allUrls, stopReason };
}

async function processGridJob(job) {
  const { jobId, input = {} } = job.data;
  const { regionName, lat, lng, zoom, mode = 'standard' } = input;
  const categories = Array.isArray(input.categories) ? input.categories : FITNESS_CATEGORIES;
  const startTime = Date.now();

  await connectDB();
  await updateJob(jobId, { status: 'running', startedAt: new Date(), bullJobId: String(job.id) });
  bus.publish('job:started', { jobId, type: 'grid', regionName, lat, lng, categories: categories.length, mode });

  const browser = new BrowserManager();
  let stopReason = false;

  try {
    await browser.launch();
    logger.info(`\n🌐 [GRID DISCOVERY] ${regionName} [${lat}, ${lng}] — ${categories.length} categories`);

    const { allUrls, stopReason: searchStop } = await searchAllCategoriesForGrid(
      browser, lat, lng, zoom, regionName, categories, jobId, job
    );
    if (searchStop) stopReason = searchStop;

    await browser.close();

    const discoveredTotal = allUrls.size;
    logger.info(`\n📋 Discovered ${discoveredTotal} unique URLs at grid [${lat}, ${lng}]`);

    const urlsToScrape = stopReason ? [] : await preFilterUrls([...allUrls], regionName);
    const total = urlsToScrape.length;
    const skippedPreFilter = discoveredTotal - total;

    await updateJob(jobId, { 
      'progress.total': discoveredTotal, 
      'progress.toScrape': total,
      $inc: { 'progress.skipped': skippedPreFilter }
    });

    if (total === 0 || stopReason) {
      const durationMs = Date.now() - startTime;
      const finalStatus = stopReason === 'cancelled' ? 'cancelled' : 'completed';
      if (stopReason === 'cancelled') await clearCancelFlag(jobId);
      await updateJob(jobId, { status: finalStatus, completedAt: new Date(), durationMs });
      return { jobId, discovered: discoveredTotal, toScrape: 0, batches: 0, status: finalStatus };
    }

    const batches = [];
    for (let i = 0; i < urlsToScrape.length; i += BATCH_SIZE) {
      batches.push(urlsToScrape.slice(i, i + BATCH_SIZE));
    }

    for (let bi = 0; bi < batches.length; bi++) {
      await addBatchScrapeJob(jobId, regionName, batches[bi], bi, mode);
    }

    await updateJob(jobId, { 'progress.batches': batches.length, 'progress.batchesDone': 0 });
    const durationMs = Date.now() - startTime;
    return { jobId, discovered: discoveredTotal, toScrape: total, batches: batches.length, durationMs };

  } catch (err) {
    await browser.close();
    const durationMs = Date.now() - startTime;
    await updateJob(jobId, { status: 'failed', completedAt: new Date(), durationMs });
    throw err;
  }
}


// ── Phase 9: Batch scrape job handler ─────────────────────────────────────────
//
// Each batch job opens its OWN browser instance, spawns PAGE_POOL tabs,
// scrapes its batch of 15-20 URLs, closes the browser, and reports results
// back to the parent city-crawl job document.
//
// Because each batch is a separate BullMQ job, different worker containers
// (replicas) pick them up in parallel — this is where the real speedup is.

async function processBatchJob(job) {
  const { parentJobId, input } = job.data;
  const { cityName, urls, batchIndex, mode = 'standard' } = input;
  const startTime = Date.now();

  await connectDB();
  logger.info(`\n📦 [BATCH ${batchIndex}] ${cityName} — ${urls.length} URLs, pagePool:${PAGE_POOL}, mode:${mode}`);
  bus.publish('crawl:batch-start', { jobId: parentJobId, cityName, batchIndex, urlCount: urls.length, pagePool: PAGE_POOL, mode });

  const browser = new BrowserManager();
  const stats   = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let stopReason = false;

  try {
    await browser.launch();

    // ── Scrape all URLs using the parallel page pool ──────────────────────
    stopReason = await processUrlsWithPool(
      browser, urls, parentJobId, cityName, stats, job, mode
    );

    await browser.close();

    const durationMs = Date.now() - startTime;
    const batchStatus = stopReason ? (stopReason === 'cancelled' ? 'cancelled' : 'partial') : 'completed';

    // ── Report batch results to parent job ────────────────────────────────
    await updateJob(parentJobId, {
      $inc: { 'progress.batchesDone': 1 },
    });

    // Check if ALL batches are done → mark parent job completed
    try {
      const parentJob = await CrawlJob.findOne({ jobId: parentJobId }).lean();
      const p = parentJob?.progress || {};
      const totalDone = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);

      if (p.batchesDone >= p.batches || (p.total > 0 && totalDone >= p.total)) {
        const totalDuration = parentJob.startedAt ? (Date.now() - new Date(parentJob.startedAt).getTime()) : durationMs;
        
        await updateJob(parentJobId, {
          status: 'completed',
          completedAt: new Date(),
          durationMs: totalDuration,
        });

        // Clear any remaining pending batches for this job
        await removeJobAndBatches(parentJobId);

        bus.publish('job:completed', {
          jobId: parentJobId, cityName,
          status: 'completed',
          durationMs: totalDuration,
        });
        logger.info(`\n🏁 [CITY COMPLETE] ${cityName} — all ${parentJob.progress.batches} batches done (${(totalDuration/1000).toFixed(1)}s total)`);
      }
    } catch (_) {}

    bus.publish('crawl:batch-done', { jobId: parentJobId, cityName, batchIndex, stats: { ...stats }, duration: durationMs, status: batchStatus });
    logger.info(`  ✅ [BATCH ${batchIndex}] Done: created:${stats.created} updated:${stats.updated} failed:${stats.failed} (${(durationMs/1000).toFixed(1)}s)`);
    return { batchIndex, stats, durationMs, status: batchStatus };

  } catch (err) {
    await browser.close();
    const durationMs = Date.now() - startTime;
    logger.error(`  💥 [BATCH ${batchIndex}] FAILED: ${err.message}`);

    // Still increment batchesDone so parent doesn't hang forever
    // Calculate how many were already incremented in stats to avoid double-counting
    const alreadyProcessed = (stats.created || 0) + (stats.updated || 0) + (stats.skipped || 0) + (stats.failed || 0);
    const remainingUrls = Math.max(0, urls.length - alreadyProcessed);

    await updateJob(parentJobId, {
      $inc: { 
        'progress.batchesDone': 1, 
        'progress.failed': remainingUrls, 
        errorCount: 1 
      },
      $push: { jobErrors: { message: `Batch ${batchIndex} failed: ${err.message}`, at: new Date() } },
    });

    // Final safeguard: check if this was the last batch (même logic as success)
    const parentJob = await CrawlJob.findOne({ jobId: parentJobId }).lean();
    const p = parentJob?.progress || {};
    const totalDone = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);
    if (p.total > 0 && totalDone >= p.total && parentJob.status === 'running') {
      await updateJob(parentJobId, { status: 'completed', completedAt: new Date() });
    }

    throw err;
  }
}

// ── Gym-name crawl job handler ───────────────────────────────────────────────

async function processGymNameJob(job) {
  const { jobId, input } = job.data;
  const { spaceName, gymName, mode = 'standard' } = input;
  const targetName = spaceName || gymName;
  const startTime = Date.now();

  await connectDB();
  await updateJob(jobId, { status: 'running', startedAt: new Date(), bullJobId: String(job.id) });
  bus.publish('job:started', { jobId, type: 'gym_name', spaceName: targetName, mode });

  const browser = new BrowserManager();
  const stats   = { created: 0, updated: 0, failed: 0 };
  let stopReason = false;

  try {
    await browser.launch();
    const page = await browser.newPage();
    await job.updateProgress(10);
    const urls = await searchGymsInCity(page, targetName, '');

    // ── Fallback search when exact-name returns 0 URLs ─────────────────────
    // If Google Maps found nothing for the verbatim name (e.g. no results
    // page, or not indexed under that exact name), try progressively shorter
    // name variants before falling back to a broader locality-category search.
    // This handles small local gyms that aren't indexed by full name but ARE
    // discoverable by partial name or by browsing the locality.
    if (urls.length === 0) {
      logger.warn(`  ⚠️  Gym-name search returned 0 URLs for "${targetName}" — trying fallback strategies`);
      await updateJob(jobId, {
        $push: { jobErrors: { message: `Initial name search returned 0 URLs, trying fallback strategies`, at: new Date() } },
      });

      const GENERIC_WORDS = new Set(['gym', 'fitness', 'center', 'centre', 'studio', 'club', 'health', 'the', 'and']);
      const nameParts = targetName.trim().split(/\s+/);

      // Strategy 1: Try progressively shorter name variants by dropping
      // generic trailing words (e.g. "RK FITNESS GYM NAHAL" → "RK FITNESS NAHAL" → "RK NAHAL")
      const meaningful = nameParts.filter(w => !GENERIC_WORDS.has(w.toLowerCase()));
      if (meaningful.length >= 2 && meaningful.length < nameParts.length) {
        const shortName = meaningful.join(' ');
        logger.info(`  🔄 Fallback 1: shortened name "${shortName}"`);
        const fallback1 = await searchGymsInCity(page, shortName, '');
        if (fallback1.length > 0) {
          logger.info(`  ✅ Fallback 1 found ${fallback1.length} URL(s)`);
          urls.push(...fallback1);
        }
      }

      // Strategy 2: Try the full name as a regular Google search
      // (Google Maps sometimes responds to "RK FITNESS NAHAL" when exact fails)
      if (urls.length === 0 && nameParts.length > 2) {
        const dropLast = nameParts.slice(0, -1).join(' ');
        logger.info(`  🔄 Fallback 2: name without last word "${dropLast}"`);
        const fallback2 = await searchGymsInCity(page, dropLast, '');
        if (fallback2.length > 0) {
          logger.info(`  ✅ Fallback 2 found ${fallback2.length} URL(s)`);
          urls.push(...fallback2);
        }
      }

      // Strategy 3: Category + locality (last word of name as locality hint)
      if (urls.length === 0) {
        const locality = nameParts[nameParts.length - 1];
        if (locality && locality.length > 2 && !GENERIC_WORDS.has(locality.toLowerCase())) {
          logger.info(`  🔄 Fallback 3: "gym in ${locality}"`);
          const fallback3 = await searchGymsInCity(page, locality, 'gym');
          if (fallback3.length > 0) {
            logger.info(`  ✅ Fallback 3 found ${fallback3.length} URL(s)`);
            urls.push(...fallback3);
          } else {
            logger.warn(`  ⚠️  All fallback strategies exhausted — gym may not be indexed on Google Maps`);
          }
        }
      }
    }

    await job.updateProgress(40);
    await updateJob(jobId, { 'progress.total': urls.length });

    let i = 0;
    for (const url of urls.slice(0, 15)) {
      stopReason = await shouldStop(jobId);
      if (stopReason) break;

      i++;
      await job.updateProgress(40 + Math.floor((i / Math.min(urls.length, 15)) * 60));
      try {
        const scraped = await scrapeGymDetail(page, url, mode);
        if (!scraped?.name) continue;
        const res = await processGym(scraped, targetName, jobId, true);
        if (res.action === 'created') { stats.created++; await updateJob(jobId, { $inc: { 'progress.newGyms': 1, 'progress.scraped': 1 }, $push: { gymIds: res.gymId } }); }
        if (res.action === 'updated') { stats.updated++; await updateJob(jobId, { $inc: { 'progress.updatedGyms': 1, 'progress.scraped': 1 }, $push: { gymIds: res.gymId } }); }
      } catch (err) {
        stats.failed++;
        logger.warn(`gym-name job err: ${err.message}`);
        await updateJob(jobId, {
          $inc: { errorCount: 1 },
          $push: { jobErrors: { message: err.message, url, at: new Date() } },
        });
      }
      await sleep(DELAY_MIN, DELAY_MAX);
    }

    await browser.close();
    const durationMs = Date.now() - startTime;

    let finalStatus;
    if (stopReason === 'cancelled') {
      finalStatus = 'cancelled';
      await clearCancelFlag(jobId);
    } else if (stopReason === 'shutdown') {
      finalStatus = 'partial';
    } else {
      finalStatus = 'completed';
    }

    await updateJob(jobId, { status: finalStatus, completedAt: new Date(), durationMs });
    return { summary: stats, jobId, durationMs, status: finalStatus };

  } catch (err) {
    await browser.close();
    const durationMs = Date.now() - startTime;
    await updateJob(jobId, { status: 'failed', completedAt: new Date(), durationMs });
    throw err;
  }
}

// ── Task 6: Gym enrichment job handler ────────────────────────────────────────
async function processEnrichmentJobHandler(job) {
  const { gymId, input = {} } = job.data;
  const { placeUrl, cityName } = input;
  const startTime = Date.now();

  if (!gymId || !placeUrl) {
    throw new Error('gym-enrichment job missing gymId or placeUrl');
  }

  await connectDB();
  logger.info(`✨ [ENRICH] gym:${gymId} (${cityName || '?'}) — ${placeUrl.slice(-60)}`);

  const browser = new BrowserManager();
  try {
    await browser.launch();
    const page = await browser.newPage();
    await job.updateProgress(20);

    let enriched = null;
    let lastErr  = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        enriched = await scrapeEnrichmentDetail(page, placeUrl);
        break;
      } catch (err) {
        lastErr = err;
        const isBlock = err.message.includes('Google blocked');
        logger.warn(`  [ENRICH] attempt ${attempt}/3 failed: ${err.message}`);
        if (isBlock) await sleep(30000, 60000);
        else         await sleep(5000 * attempt, 8000 * attempt);
      }
    }
    await job.updateProgress(75);
    if (!enriched) throw lastErr || new Error('scrapeEnrichmentDetail returned null');

    const res = await processEnrichmentJob(enriched, gymId, job.id);
    await job.updateProgress(100);
    await browser.close();

    const durationMs = Date.now() - startTime;
    logger.info(`  [ENRICH] Done: action=${res.action} +${res.newReviews}rev +${res.newPhotos}photos (${(durationMs/1000).toFixed(1)}s)`);
    return { gymId, ...res, durationMs };

  } catch (err) {
    await browser.close();
    logger.error(`  [ENRICH] FAILED gym:${gymId}: ${err.message}`);
    throw err;
  }
}

// ── Worker startup ───────────────────────────────────────────────────────────

async function start() {
  await connectDB();

  // ── Crawl Worker (city-crawl, batch-scrape, gym-name-crawl) ───────────────
  const worker = new Worker('atlas-crawl', async (job) => {
    logger.info(`⚙️  Processing job: ${job.name} [${job.id}]`);
    if (job.name === 'city-crawl')     return processCityJob(job);
    if (job.name === 'grid-crawl')     return processGridJob(job);
    if (job.name === 'batch-scrape')   return processBatchJob(job);
    if (job.name === 'gym-name-crawl') return processGymNameJob(job);
    throw new Error(`Unknown job name: ${job.name}`);
  }, {
    connection,
    concurrency: CONCURRENCY,
    lockDuration:    2_700_000,
    lockRenewTime:     300_000,
  });

  // ── Enrichment Worker (gym-enrichment) ────────────────────────────────
  // Separate worker for the enrichment queue. Concurrency=1 per container
  // to avoid opening too many browser instances simultaneously.
  const enrichWorker = new Worker('atlas-enrichment', async (job) => {
    logger.info(`✨ Processing enrichment job: ${job.name} [${job.id}]`);
    if (job.name === 'gym-enrichment') return processEnrichmentJobHandler(job);
    throw new Error(`Unknown enrichment job: ${job.name}`);
  }, {
    connection,
    concurrency: 1,            // 1 browser per enrichment worker
    lockDuration:    1_800_000, // 30 min lock per gym (500 reviews takes time)
    lockRenewTime:     300_000,
  });

  worker.on('completed',      (job) => logger.info(`✅ Job completed: ${job.id}`));
  worker.on('failed',         (job, err) => logger.error(`❌ Job failed: ${job?.id} — ${err.message}`));
  worker.on('error',          (err) => logger.error(`Worker error: ${err.message}`));
  enrichWorker.on('completed',(job) => logger.info(`✅ Enrichment completed: ${job.id}`));
  enrichWorker.on('failed',   (job, err) => logger.error(`❌ Enrichment failed: ${job?.id} — ${err.message}`));
  enrichWorker.on('error',    (err) => logger.error(`Enrichment worker error: ${err.message}`));

  logger.info(`\n🚀 Atlas Worker started  [concurrency: ${CONCURRENCY}, pagePool: ${PAGE_POOL}, lockDuration: 1800s, lockRenewTime: 300s]`);
  logger.info(`✨ Enrichment Worker started [concurrency: 1, lockDuration: 1800s]`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`\n⏳ Received ${signal} — finishing current gym(s) and shutting down...`);

    try { await worker.close(); } catch (_) {}
    try { await enrichWorker.close(); } catch (_) {}

    logger.info('👋 Worker shut down gracefully.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => { console.error('Worker startup error:', err); process.exit(1); });
