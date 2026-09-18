'use strict';
require('dotenv').config();

const { Worker } = require('bullmq');
const { connectDB }   = require('../db/connection');
const { BrowserManager, searchSpacesInCity, searchSpacesInGrid, scrapeSpaceDetail, scrapeEnrichmentDetail, FITNESS_CATEGORIES, isBlocked, placeKeysFromUrl } = require('../scraper/googleMapsScraper');
const { processSpace }  = require('../scraper/spaceProcessor');
const { processEnrichmentJob } = require('../scraper/enrichmentProcessor');
const CrawlJob        = require('../db/crawlJobModel');
const Space             = require('../db/spaceModel');
const SystemState     = require('../db/systemStateModel');
const { isJobCancelled, clearCancelFlag, addBatchScrapeJob, removeJobAndBatches, enrichmentQueue } = require('./queues');
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

// ── BullMQ lock timing ───────────────────────────────────────────────────────
// A live worker renews its job lock every LOCK_RENEW_TIME, so LOCK_DURATION
// governs how long a CRASHED worker's job stays stuck in `active` before the
// stalled-checker can hand it to another worker. Keep it a small multiple of
// the renew interval, not the length of the longest job.
const LOCK_DURATION        = parseInt(process.env.WORKER_LOCK_DURATION_MS   || '900000', 10);  // 15 min
const ENRICH_LOCK_DURATION = parseInt(process.env.ENRICH_LOCK_DURATION_MS   || '900000', 10);  // 15 min
const LOCK_RENEW_TIME      = parseInt(process.env.WORKER_LOCK_RENEW_MS      || '300000', 10);  // 5 min
const STALLED_INTERVAL     = parseInt(process.env.WORKER_STALLED_INTERVAL_MS || '30000', 10);  // 30 s

// ── Graceful shutdown state & shared worker utils ────────────────────────────
let isShuttingDown = false;

const {
  sleep: sleepUtil,
  updateJob,
  shouldStop: shouldStopUtil,
  AdaptiveThrottle,
} = require('./workerUtils');

const sleep = (min, max) => sleepUtil(min, max, () => isShuttingDown);
const shouldStop = (jobId) => shouldStopUtil(jobId, () => isShuttingDown);

// ── Phase 2: Parallel page pool URL processor ────────────────────────────────
/**
 * Processes a list of URLs using a pool of N parallel browser pages.
 * Each page picks the next available URL from a shared index (work-stealing).
 *
 * @param {BrowserManager} browser  - Active BrowserManager instance
 * @param {string[]}       urls     - Full list of URLs to process
 * @param {string}         jobId    - For cancellation checks and DB updates
 * @param {string}         cityName - City label for processSpace
 * @param {object}         stats    - Shared stats object (mutated in place)
 * @param {object}         bullJob  - BullMQ job for progress updates
 * @param {string}         mode     - Scrape mode: 'fast' | 'standard' | 'deep'
 */
async function processUrlsWithPool(browser, urls, jobId, cityName, stats, bullJob, mode = 'standard') {
  const total = urls.length;
  // Shared mutable state for work-stealing across parallel workers.
  // claimNextUrl() provides an explicit, synchronous index claim to prevent
  // any future refactor from accidentally splitting read+increment across awaits.
  const shared = { nextIndex: 0 };
  function claimNextUrl() {
    const idx = shared.nextIndex;
    shared.nextIndex++;
    return idx;
  }
  // Every index that reached a terminal outcome (created/updated/skipped/failed).
  // Anything missing at the end was claimed and abandoned — by cancellation,
  // shutdown, or the circuit breaker — and must be reported to the caller so it
  // can be requeued instead of silently vanishing from the job's totals.
  const settled = new Set();
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
  async function workerLoop(initialPage) {
    let page = initialPage;
    let urlsOnPage = 0;
    const PAGE_RECYCLE_BUDGET = 35; // Gap 10: Refresh page every 35 URLs to release Chromium renderer memory

    try {
      while (true) {
        // Claim the next URL index — synchronous, no await between read and increment
        const idx = claimNextUrl();
        if (idx >= total) break;

        // Gap 10: Recycle browser page when budget exceeded
        if (urlsOnPage >= PAGE_RECYCLE_BUDGET) {
          try {
            await page.close();
            page = await browser.newPage();
            urlsOnPage = 0;
          } catch (_) {}
        }
        urlsOnPage++;

        const url = urls[idx];
        const urlShort = url.split('/maps/place/')[1]?.split('/')[0] || url.slice(-50);

      // Check cancellation before each URL
      const stop = await shouldStop(jobId);
      if (stop) { stopReason = stop; break; }

      // Gap 8: Circuit breaker check — halt pool if consecutive failures/blocks tripped breaker
      if (throttle.tripped) {
        logger.error(`  🚨 Circuit breaker tripped after ${throttle.consecutiveFails} failures (${throttle.tripReason}). Stopping URL processing pool.`);
        stopReason = 'circuit_breaker';
        break;
      }

      // Human-like pause: every 5-8 URLs, take a random break
      if (idx > 0 && idx >= nextPauseAt) {
        const pauseMs = 5000 + Math.random() * 10000;
        logger.info(`  ☕ Human pause at URL ${idx}/${total}: ${(pauseMs/1000).toFixed(1)}s (throttle: ${throttle.status})`);
        bus.publish('crawl:human-pause', { jobId, pauseMs: Math.round(pauseMs), urlIndex: idx, total });
        await sleep(pauseMs, pauseMs + 1000);
        nextPauseAt = idx + 5 + Math.floor(Math.random() * 4);
      }

      await bullJob.updateProgress(25 + Math.floor((idx / total) * 75));

      // Publish space-start event
      bus.publish('crawl:space-start', { jobId, url: urlShort, urlIndex: idx, total });
      const spaceStartTime = Date.now();

      let scraped = null;
      let lastError = null;

      // Whether any attempt for THIS url hit a genuine Google block. The
      // throttle is notified once per URL below rather than once per attempt —
      // counting every retry separately made a single bad URL look like three
      // or four consecutive failures and tripped the circuit breaker after
      // roughly two URLs.
      let sawBlock = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try { scraped = await scrapeSpaceDetail(page, url, mode, browser.ctx); break; }
        catch (err) {
          lastError = err;
          const isBlock = err.message.includes('Google blocked');
          if (isBlock) sawBlock = true;
          logger.warn(`  ⚠  Attempt ${attempt}/${MAX_RETRIES} [${url.slice(-40)}]: ${err.message}`);
          bus.publish('crawl:space-failed', { jobId, url: urlShort, error: err.message.slice(0, 120), attempt, maxRetries: MAX_RETRIES, isBlock });

          // If Google blocked us, add a MUCH longer backoff
          if (isBlock) {
            const cooldownMs = 30000 + Math.random() * 30000;
            logger.warn('  🛑 Google block detected — cooling down for 30-60s');
            bus.publish('crawl:block', { jobId, reason: err.message.slice(0, 80), cooldownMs: Math.round(cooldownMs) });
            await sleep(30000, 60000);
          } else {
            await sleep(3000 * attempt, 5000 * attempt);
          }
        }
      }

      if (!scraped?.name) {
        settled.add(idx);
        stats.failed++;
        throttle.onFailure(sawBlock, jobId);
        await updateJob(jobId, {
          $inc: { 'progress.failed': 1, errorCount: 1 },
          $push: { jobErrors: { message: lastError?.message || 'Could not extract space data', url, at: new Date() } },
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
      settled.add(idx);
      throttle.onSuccess(jobId);
      const spaceDuration = Date.now() - spaceStartTime;
      bus.publish('crawl:space-done', { jobId, spaceName: scraped.name, url: urlShort, action: 'pending', duration: spaceDuration });

      const res = await processSpace(scraped, cityName, jobId, true);

      if (res.action === 'created') {
        stats.created++;
        await updateJob(jobId, { $inc: { 'progress.newSpaces': 1, 'progress.scraped': 1 }, $push: { spaceIds: res.spaceId } });
        bus.publish('space:created', { name: scraped.name, area: cityName, spaceId: String(res.spaceId) });
      }
      if (res.action === 'updated') {
        stats.updated++;
        await updateJob(jobId, { $inc: { 'progress.updatedSpaces': 1, 'progress.scraped': 1 }, $push: { spaceIds: res.spaceId } });
        bus.publish('space:updated', { name: scraped.name, area: cityName, spaceId: String(res.spaceId), changes: 1 });
      }
      if (res.action === 'skipped') {
        stats.skipped++; 
        await updateJob(jobId, { 
          $inc: { 'progress.skipped': 1 },
          $push: { skipLogs: { message: res.skipReason || 'Already up to date in database', url, spaceName: scraped.name, at: new Date() } }
        }); 
      }
      if (res.action === 'error')   {
        stats.failed++;
        await updateJob(jobId, {
          $inc: { 'progress.failed': 1, errorCount: 1 },
          $push: { jobErrors: { message: res.error || 'processSpace error', url, at: new Date() } },
        });
      }

      // Adaptive inter-URL delay
      await throttle.wait();
    }
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

  // Run all page workers concurrently
  await Promise.all(pages.map(page => workerLoop(page)));

  // Close all pages
  await Promise.all(pages.map(async (page) => { try { await page.close(); } catch (_) {} }));

  // URLs that never reached a terminal outcome. Previously these were dropped
  // on the floor whenever the pool stopped early, so a batch could report
  // "completed" having touched half its URLs and the parent job's
  // scraped+failed+skipped never added up to toScrape.
  const unprocessed = urls.filter((_, i) => !settled.has(i));

  logger.info(`  📊 Batch complete — throttle final: ${throttle.status}${unprocessed.length ? `, ${unprocessed.length} URL(s) unprocessed` : ''}`);
  return { stopReason, unprocessed };
}

// ── Phase 6: Parallel category search ────────────────────────────────────────
/**
 * Opens SEARCH_POOL browser pages simultaneously and splits 'categories'
 * across them using work-stealing so all pages stay busy.
 * Returns a Set of unique space URLs found across all categories.
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
      await updateJob(jobId, {}); // heartbeat — discovery phase has no other DB write per category
      try {
        const urls = await searchSpacesInCity(page, cityName, cat);
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
 * Loads googleMapsUrl values for spaces in this city that were crawled
 * within SKIP_RECENT_DAYS. Removes those from the URL list so we
 * don't waste scrape time on unchanged spaces.
 */
async function preFilterUrls(urls, cityName) {
  if (!SKIP_RECENT_DAYS || SKIP_RECENT_DAYS <= 0) return [...urls];

  try {
    const cutoff = new Date(Date.now() - SKIP_RECENT_DAYS * 86_400_000);

    const recentSpaces = await Space.aggregate([
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
      { $project: { googleMapsUrl: 1, placeId: 1, effectiveLastCrawledAt: 1 } },
    ]);

    // Discovery URLs are result-feed hrefs (`/maps/place/<Name>/data=…`) while
    // stored googleMapsUrl values are settled address-bar URLs
    // (`/maps/place/<Name>/@lat,lng,17z/data=…`). Raw string comparison never
    // matches across those two shapes, so compare on extracted place identity
    // (feature id → CID → place-name path) instead.
    const knownKeyMap = new Map();
    recentSpaces.forEach(g => {
      const keys = placeKeysFromUrl(g.googleMapsUrl);
      if (g.placeId) keys.push(`cid:${g.placeId}`, `fid:${String(g.placeId).toLowerCase()}`);
      for (const k of keys) {
        if (!knownKeyMap.has(k)) knownKeyMap.set(k, g.effectiveLastCrawledAt);
      }
    });

    const matchKey = (u) => placeKeysFromUrl(u).find(k => knownKeyMap.has(k));

    const fresh = [];
    const skippedUrls = [];
    for (const u of urls) {
      const hit = matchKey(u);
      if (hit) skippedUrls.push({ url: u, lastCrawledAt: knownKeyMap.get(hit) });
      else fresh.push(u);
    }
    const skipped = skippedUrls.length;

    if (skipped > 0) {
      logger.info(`  🔎 Pre-filter: skipping ${skipped}/${urls.length} recently-crawled URLs (within ${SKIP_RECENT_DAYS}d)`);
    }
    return { fresh, skippedUrls };
  } catch (err) {
    // Non-fatal — fall back to scraping all URLs.
    // IMPORTANT: must return the same { fresh, skippedUrls } shape that callers expect.
    logger.warn(`Pre-filter query failed (scraping all): ${err.message}`);
    return { fresh: [...urls], skippedUrls: [] };
  }
}

// ── City crawl job handler (Phase 9: discovery-only → enqueue batches) ───────
//
// The city job no longer scrapes any space details itself.
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
    const preFilterResult = stopReason ? { fresh: [], skippedUrls: [] } : await preFilterUrls([...allUrls], cityName);
    const urlsToScrape = preFilterResult.fresh;
    const total = urlsToScrape.length;
    const skippedPreFilter = preFilterResult.skippedUrls.length;

    await updateJob(jobId, { 
      'progress.total': discoveredTotal, 
      'progress.toScrape': total,
      $inc: { 'progress.skipped': skippedPreFilter }
    });
    
    if (skippedPreFilter > 0) {
      await updateJob(jobId, {
        $push: { 
          skipLogs: { 
            $each: preFilterResult.skippedUrls.slice(0, 50).map(u => {
              const daysAgo = u.lastCrawledAt ? Math.round((Date.now() - new Date(u.lastCrawledAt).getTime()) / 86400000) : 0;
              const timeText = daysAgo === 0 ? 'today' : `${daysAgo} days ago`;
              return { 
                message: `Pre-filtered: crawled ${timeText}`, 
                url: u.url, 
                at: new Date() 
              };
            }) 
          }
        }
      });
    }

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
      await updateJob(jobId, {}); // heartbeat — discovery phase has no other DB write per category
      try {
        const urls = await searchSpacesInGrid(page, lat, lng, zoom, cat);
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

    const preFilterResult = stopReason ? { fresh: [], skippedUrls: [] } : await preFilterUrls([...allUrls], regionName);
    const urlsToScrape = preFilterResult.fresh;
    const total = urlsToScrape.length;
    const skippedPreFilter = preFilterResult.skippedUrls.length;

    await updateJob(jobId, { 
      'progress.total': discoveredTotal, 
      'progress.toScrape': total,
      $inc: { 'progress.skipped': skippedPreFilter }
    });
    
    if (skippedPreFilter > 0) {
      await updateJob(jobId, {
        $push: { 
          skipLogs: { 
            $each: preFilterResult.skippedUrls.slice(0, 50).map(u => {
              const daysAgo = u.lastCrawledAt ? Math.round((Date.now() - new Date(u.lastCrawledAt).getTime()) / 86400000) : 0;
              const timeText = daysAgo === 0 ? 'today' : `${daysAgo} days ago`;
              return { 
                message: `Pre-filtered: crawled ${timeText}`, 
                url: u.url, 
                at: new Date() 
              };
            }) 
          }
        }
      });
    }

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

// Max times a batch's leftover URLs may be requeued after an early stop
// (circuit breaker). Bounded so a permanently-blocked IP can't loop forever.
const MAX_BATCH_REQUEUES = 2;

async function processBatchJob(job) {
  const { parentJobId, input } = job.data;
  const { cityName, urls, batchIndex, mode = 'standard', requeueCount = 0 } = input;
  const startTime = Date.now();

  await connectDB();
  logger.info(`\n📦 [BATCH ${batchIndex}] ${cityName} — ${urls.length} URLs, pagePool:${PAGE_POOL}, mode:${mode}${requeueCount ? ` (requeue ${requeueCount}/${MAX_BATCH_REQUEUES})` : ''}`);
  bus.publish('crawl:batch-start', { jobId: parentJobId, cityName, batchIndex, urlCount: urls.length, pagePool: PAGE_POOL, mode });

  const browser = new BrowserManager();
  const stats   = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let stopReason = false;

  try {
    await browser.launch();

    // ── Scrape all URLs using the parallel page pool ──────────────────────
    const poolResult = await processUrlsWithPool(
      browser, urls, parentJobId, cityName, stats, job, mode
    );
    stopReason = poolResult.stopReason;
    const unprocessed = poolResult.unprocessed;

    await browser.close();

    const durationMs = Date.now() - startTime;
    const batchStatus = stopReason ? (stopReason === 'cancelled' ? 'cancelled' : 'partial') : 'completed';

    // ── Account for URLs the pool never finished ──────────────────────────
    // A circuit-breaker trip used to abandon the rest of the batch without
    // touching the parent's counters, so the job looked complete while a
    // chunk of the city had never been visited. Requeue them behind a cooldown
    // (the breaker means Google is unhappy right now, not that the URLs are
    // bad); only count them as failed once the requeue budget is spent.
    let requeued = 0;
    if (unprocessed.length > 0) {
      const retryable = stopReason === 'circuit_breaker' || stopReason === 'shutdown';
      if (retryable && requeueCount < MAX_BATCH_REQUEUES) {
        const retryJobId = `${parentJobId}:batch:${batchIndex}r${requeueCount + 1}`;
        const delayMs = 120_000 * (requeueCount + 1); // 2min, then 4min
        await addBatchScrapeJob(
          parentJobId, cityName, unprocessed, `${batchIndex}r${requeueCount + 1}`, mode,
          { jobId: retryJobId, delay: delayMs, requeueCount: requeueCount + 1 }
        );
        requeued = unprocessed.length;
        // The retry is a new batch the parent must wait for.
        await updateJob(parentJobId, { $inc: { 'progress.batches': 1 } });
        logger.warn(`  ↻ [BATCH ${batchIndex}] Requeued ${requeued} unprocessed URL(s) in ${delayMs / 1000}s (reason: ${stopReason})`);
        bus.publish('crawl:batch-requeued', { jobId: parentJobId, cityName, batchIndex, count: requeued, delayMs, reason: stopReason });
      } else if (stopReason !== 'cancelled') {
        await updateJob(parentJobId, {
          $inc: { 'progress.failed': unprocessed.length, errorCount: 1 },
          $push: { jobErrors: { message: `Batch ${batchIndex}: ${unprocessed.length} URL(s) abandoned (${stopReason || 'unknown'})`, at: new Date() } },
        });
        stats.failed += unprocessed.length;
        logger.warn(`  ⚠  [BATCH ${batchIndex}] ${unprocessed.length} URL(s) abandoned and counted as failed (${stopReason})`);
      }
    }

    // ── Report batch results to parent job ────────────────────────────────
    await updateJob(parentJobId, {
      $inc: { 'progress.batchesDone': 1 },
    });

    // Check if ALL batches are done → mark parent job completed
    try {
      const parentJob = await CrawlJob.findOne({ jobId: parentJobId }).lean();
      const p = parentJob?.progress || {};
      const totalDone = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);

      // Gap 15: batchesDone >= batches is authoritative; totalDone >= toScrape is secondary safety
      const isComplete = (p.batches > 0 && p.batchesDone >= p.batches) ||
                         (p.toScrape > 0 && totalDone >= p.toScrape);

      if (isComplete && parentJob.status === 'running') {
        const totalDuration = parentJob.startedAt ? (Date.now() - new Date(parentJob.startedAt).getTime()) : durationMs;
        
        await updateJob(parentJobId, {
          status: 'completed',
          completedAt: new Date(),
          durationMs: totalDuration,
        });

        // Gap 17: Defer batch cleanup out of lock-holding path
        setImmediate(() => {
          removeJobAndBatches(parentJobId).catch(err => {
            logger.warn(`Deferred batch cleanup error: ${err.message}`);
          });
        });

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

    // Final safeguard: check if this was the last batch (Gap 15 & Gap 17)
    try {
      const parentJob = await CrawlJob.findOne({ jobId: parentJobId }).lean();
      const p = parentJob?.progress || {};
      const totalDone = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);
      const isComplete = (p.batches > 0 && p.batchesDone >= p.batches) ||
                         (p.toScrape > 0 && totalDone >= p.toScrape);

      if (isComplete && parentJob?.status === 'running') {
        const totalDuration = parentJob.startedAt ? (Date.now() - new Date(parentJob.startedAt).getTime()) : durationMs;
        await updateJob(parentJobId, { status: 'completed', completedAt: new Date(), durationMs: totalDuration });
        setImmediate(() => {
          removeJobAndBatches(parentJobId).catch(() => {});
        });
        bus.publish('job:completed', {
          jobId: parentJobId, cityName,
          status: 'completed',
          durationMs: totalDuration,
        });
      }
    } catch (_) {}

    throw err;
  }
}

// ── Space-name crawl job handler ───────────────────────────────────────────────

async function processSpaceNameJob(job) {
  const { jobId, input } = job.data;
  const { spaceName, mode = 'standard' } = input;
  const targetName = spaceName;
  const startTime = Date.now();

  await connectDB();
  await updateJob(jobId, { status: 'running', startedAt: new Date(), bullJobId: String(job.id) });
  bus.publish('job:started', { jobId, type: 'space_name', spaceName: targetName, mode });

  const browser = new BrowserManager();
  const stats   = { created: 0, updated: 0, failed: 0 };
  let stopReason = false;

  try {
    await browser.launch();
    const page = await browser.newPage();
    await job.updateProgress(10);
    const urls = await searchSpacesInCity(page, targetName, '');

    // ── Fallback search when exact-name returns 0 URLs ─────────────────────
    // If Google Maps found nothing for the verbatim name (e.g. no results
    // page, or not indexed under that exact name), try progressively shorter
    // name variants before falling back to a broader locality-category search.
    // This handles small local spaces that aren't indexed by full name but ARE
    // discoverable by partial name or by browsing the locality.
    if (urls.length === 0) {
      logger.warn(`  ⚠️  Space-name search returned 0 URLs for "${targetName}" — trying fallback strategies`);
      await updateJob(jobId, {
        $push: { jobErrors: { message: `Initial name search returned 0 URLs, trying fallback strategies`, at: new Date() } },
      });

      const GENERIC_WORDS = new Set(['space', 'fitness', 'center', 'centre', 'studio', 'club', 'health', 'the', 'and']);
      const nameParts = targetName.trim().split(/\s+/);

      // Strategy 1: Try progressively shorter name variants by dropping
      // generic trailing words (e.g. "RK FITNESS SPACE NAHAL" → "RK FITNESS NAHAL" → "RK NAHAL")
      const meaningful = nameParts.filter(w => !GENERIC_WORDS.has(w.toLowerCase()));
      if (meaningful.length >= 2 && meaningful.length < nameParts.length) {
        const shortName = meaningful.join(' ');
        logger.info(`  🔄 Fallback 1: shortened name "${shortName}"`);
        const fallback1 = await searchSpacesInCity(page, shortName, '');
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
        const fallback2 = await searchSpacesInCity(page, dropLast, '');
        if (fallback2.length > 0) {
          logger.info(`  ✅ Fallback 2 found ${fallback2.length} URL(s)`);
          urls.push(...fallback2);
        }
      }

      // Strategy 3: Category + locality (last word of name as locality hint)
      if (urls.length === 0) {
        const locality = nameParts[nameParts.length - 1];
        if (locality && locality.length > 2 && !GENERIC_WORDS.has(locality.toLowerCase())) {
          logger.info(`  🔄 Fallback 3: "space in ${locality}"`);
          const fallback3 = await searchSpacesInCity(page, locality, 'space');
          if (fallback3.length > 0) {
            logger.info(`  ✅ Fallback 3 found ${fallback3.length} URL(s)`);
            urls.push(...fallback3);
          } else {
            logger.warn(`  ⚠️  All fallback strategies exhausted — space may not be indexed on Google Maps`);
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
        const scraped = await scrapeSpaceDetail(page, url, mode, browser.ctx);
        if (!scraped?.name) continue;
        const res = await processSpace(scraped, targetName, jobId, true);
        if (res.action === 'created') { stats.created++; await updateJob(jobId, { $inc: { 'progress.newSpaces': 1, 'progress.scraped': 1 }, $push: { spaceIds: res.spaceId } }); }
        if (res.action === 'updated') { stats.updated++; await updateJob(jobId, { $inc: { 'progress.updatedSpaces': 1, 'progress.scraped': 1 }, $push: { spaceIds: res.spaceId } }); }
        if (res.action === 'skipped') { 
          await updateJob(jobId, { 
            $inc: { 'progress.skipped': 1 },
            $push: { skipLogs: { message: res.skipReason || 'Already up to date', url, spaceName: scraped.name, at: new Date() } }
          });
        }
      } catch (err) {
        stats.failed++;
        logger.warn(`space-name job err: ${err.message}`);
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

// ── Task 6: Space enrichment job handler ────────────────────────────────────────
async function processEnrichmentJobHandler(job) {
  const { spaceId, input = {} } = job.data;
  const { placeUrl, cityName } = input;
  const startTime = Date.now();

  if (!spaceId || !placeUrl) {
    throw new Error('space-enrichment job missing spaceId or placeUrl');
  }

  await connectDB();
  logger.info(`✨ [ENRICH] space:${spaceId} (${cityName || '?'}) — ${placeUrl.slice(-60)}`);

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

    const res = await processEnrichmentJob(enriched, spaceId, job.id);
    await job.updateProgress(100);
    await browser.close();

    const durationMs = Date.now() - startTime;
    logger.info(`  [ENRICH] Done: action=${res.action} +${res.newReviews}rev +${res.newPhotos}photos (${(durationMs/1000).toFixed(1)}s)`);
    return { spaceId, ...res, durationMs };

  } catch (err) {
    await browser.close();
    logger.error(`  [ENRICH] FAILED space:${spaceId}: ${err.message}`);
    throw err;
  }
}

// ── Worker startup ───────────────────────────────────────────────────────────

async function start() {
  await connectDB();

  // ── Crash guards ─────────────────────────────────────────────────────────
  // A stray async throw (e.g. from a setImmediate callback) used to kill this
  // process outright with nothing in the winston logs, leaving jobs sitting in
  // the queue with no worker to run them. Log loudly and keep serving instead.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection in worker: ${reason?.stack || reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception in worker: ${err?.stack || err?.message || err}`);
  });

  // ── Paused-queue check ───────────────────────────────────────────────────
  // A paused queue still accepts jobs but never runs them. This is the single
  // most common reason for "the job is queued and nothing happens", and it is
  // otherwise completely silent.
  try {
    const { getPausedStates } = require('./queues');
    const paused = await getPausedStates();
    for (const [name, isPaused] of Object.entries(paused)) {
      if (isPaused) {
        logger.error(`⏸️  Queue "${name}" is PAUSED — jobs will be accepted but never processed. Resume it via POST /api/crawl/queue/resume.`);
      }
    }
  } catch (pauseErr) {
    logger.warn(`Could not read queue paused state: ${pauseErr.message}`);
  }

  // Reconcile orphaned running jobs left from prior worker crashes
  try {
    const { reconcileOrphanedJobs } = require('../services/jobReconciliationService');
    await reconcileOrphanedJobs();
  } catch (recErr) {
    logger.warn(`Worker startup reconciliation error: ${recErr.message}`);
  }

  // ── Crawl Worker (city-crawl, batch-scrape, space-name-crawl) ───────────────
  const worker = new Worker('atlas-crawl', async (job) => {
    logger.info(`⚙️  Processing job: ${job.name} [${job.id}]`);
    if (job.name === 'city-crawl')     return processCityJob(job);
    if (job.name === 'grid-crawl')     return processGridJob(job);
    if (job.name === 'batch-scrape')   return processBatchJob(job);
    if (job.name === 'space-name-crawl') return processSpaceNameJob(job);
    throw new Error(`Unknown job name: ${job.name}`);
  }, {
    connection,
    concurrency: CONCURRENCY,
    // lockDuration only has to outlast the renewal timer, not the whole job:
    // BullMQ re-extends the lock every lockRenewTime for as long as the worker
    // is alive. Sizing it to the worst-case job duration (45 min) meant that
    // after a worker crash the in-flight batch sat in `active` — invisible and
    // untouched — for 45 minutes before the stalled-checker could recover it,
    // which reads to an operator as "the job is queued and nothing happens".
    // 15 min still gives 3 renewal attempts of headroom.
    lockDuration:    LOCK_DURATION,
    lockRenewTime:   LOCK_RENEW_TIME,
    stalledInterval: STALLED_INTERVAL,
  });

  // ── Enrichment Worker (space-enrichment) ────────────────────────────────
  // Separate worker for the enrichment queue. Concurrency=1 per container
  // to avoid opening too many browser instances simultaneously.
  const enrichWorker = new Worker('atlas-enrichment', async (job) => {
    logger.info(`✨ Processing enrichment job: ${job.name} [${job.id}]`);
    if (job.name === 'space-enrichment') return processEnrichmentJobHandler(job);
    throw new Error(`Unknown enrichment job: ${job.name}`);
  }, {
    connection,
    concurrency: 1,            // 1 browser per enrichment worker
    lockDuration:    ENRICH_LOCK_DURATION,
    lockRenewTime:   LOCK_RENEW_TIME,
    stalledInterval: STALLED_INTERVAL,
  });

  worker.on('completed',      (job) => logger.info(`✅ Job completed: ${job.id}`));
  worker.on('failed',         (job, err) => logger.error(`❌ Job failed: ${job?.id} — ${err.message}`));
  worker.on('error',          (err) => logger.error(`Worker error: ${err.message}`));
  enrichWorker.on('completed',(job) => logger.info(`✅ Enrichment completed: ${job.id}`));
  enrichWorker.on('failed',   (job, err) => logger.error(`❌ Enrichment failed: ${job?.id} — ${err.message}`));
  enrichWorker.on('error',    (err) => logger.error(`Enrichment worker error: ${err.message}`));

  logger.info(`\n🚀 Atlas Worker started  [concurrency: ${CONCURRENCY}, pagePool: ${PAGE_POOL}, lockDuration: ${LOCK_DURATION / 1000}s, lockRenewTime: ${LOCK_RENEW_TIME / 1000}s]`);
  logger.info(`✨ Enrichment Worker started [concurrency: 1, lockDuration: ${ENRICH_LOCK_DURATION / 1000}s]`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`\n⏳ Received ${signal} — finishing current space(s) and shutting down...`);

    try { await worker.close(); } catch (_) {}
    try { await enrichWorker.close(); } catch (_) {}

    logger.info('👋 Worker shut down gracefully.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => { console.error('Worker startup error:', err); process.exit(1); });
