'use strict';
/**
 * Chain Worker — Dedicated worker process for gym chain crawling.
 *
 * Runs as a SEPARATE Node.js process from the city/gym worker.
 * Usage:  npm run worker:chain
 *
 * Architecture:
 *   - Listens on queue: 'atlas-chain-crawl'
 *   - Each chain job: fetches all locations from store locator, then
 *     enriches via Google Maps in parallel using p-limit.
 *   - Reuses existing processGym() + upsertGym() pipeline for DB writes.
 *   - Skip-if-fresh: gyms crawled within 7 days are skipped.
 */

require('dotenv').config();

const { Worker }        = require('bullmq');
const pLimit            = require('p-limit');
const { connectDB }     = require('../db/connection');
const { getLocator }    = require('../scraper/chainLocators');
const { fetchByBrand }  = require('../scraper/chainLocators/osmFallback');
const { BrowserManager, scrapeGymDetail } = require('../scraper/googleMapsScraper');
const { processGym }    = require('../scraper/gymProcessor');
const CrawlJob          = require('../db/crawlJobModel');
const Gym               = require('../db/spaceModel');
const GymChain          = require('../db/gymChainModel');
const SystemState       = require('../db/systemStateModel');
const { isJobCancelled, clearCancelFlag } = require('./queues');
const cfg               = require('../../config');
const logger            = require('../utils/logger');
const bus               = require('../services/eventBus');

const connection = {
  host:     cfg.redis.host,
  port:     cfg.redis.port,
  password: cfg.redis.password || undefined,
};

const CHAIN_CONCURRENCY = parseInt(process.env.CHAIN_WORKER_CONCURRENCY || '2', 10);
const ENRICH_CONCURRENCY = parseInt(process.env.CHAIN_ENRICH_CONCURRENCY || '3', 10);
const FRESHNESS_DAYS = parseInt(process.env.CHAIN_FRESHNESS_DAYS || '7', 10);
const DELAY_MIN = cfg.scraper.delayMin;
const DELAY_MAX = cfg.scraper.delayMax;
const MAX_RETRIES = cfg.scraper.maxRetries;

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

async function shouldStop(jobId) {
  if (isShuttingDown) return 'shutdown';
  try {
    if (await isJobCancelled(jobId)) return 'cancelled';
  } catch (_) {}
  return false;
}

// ── Freshness check: skip gyms crawled within N days ──────────────────────────

async function checkFreshness(location) {
  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);

  // Try to find existing gym by geo proximity + name
  if (location.lat && location.lng && location.name) {
    try {
      const nearby = await Gym.find({
        location: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [location.lng, location.lat] },
            $maxDistance: 100,  // 100m radius for chain matching
          },
        },
      }).limit(5).lean();

      for (const gym of nearby) {
        // Fuzzy name match — chain gyms often have slight name variations
        const normLoc = (location.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const normGym = (gym.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        if (normLoc.includes(normGym) || normGym.includes(normLoc) ||
            (location.chainSlug && gym.chainSlug === location.chainSlug)) {
          // Found existing gym
          const lastCrawled = gym.crawl?.lastCrawledAt || gym.rawCrawlMeta?.lastCrawledAt || gym.crawlMeta?.lastCrawledAt || gym.updatedAt;
          const isFresh = lastCrawled && lastCrawled > cutoff;

          return {
            exists: true,
            gymId: gym._id,
            isFresh,
            needsChainTag: !gym.isChainMember || gym.chainSlug !== location.chainSlug,
            lastCrawled,
          };
        }
      }
    } catch (err) {
      // location index may not exist — non-fatal
    }
  }

  return { exists: false, gymId: null, isFresh: false, needsChainTag: false };
}

// ── Tag a gym with chain identity (fast $set, no scraping) ────────────────────

async function tagWithChain(gymId, chainId, chainSlug, chainName) {
  await Gym.findByIdAndUpdate(gymId, {
    $set: {
      chainId,
      chainSlug,
      chainName,
      isChainMember: true,
    },
  });
}

// ── Enrich a single location via Google Maps ──────────────────────────────────

async function enrichViaGoogleMaps(page, location, chainId, chainSlug, chainName, areaName, jobId) {
  const searchQuery = `${location.name} ${location.city || ''} ${location.state || ''} ${location.country || ''}`.trim();
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

  try {
    // Navigate to Google Maps search
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: cfg.scraper.timeout });
    await sleep(2000, 3000);

    // Check if we landed directly on a place or on a list
    const directPlace = await page.locator('h1.DUwDvf, h1[data-attrid="title"]').isVisible({ timeout: 3000 }).catch(() => false);

    let scraped;
    if (directPlace) {
      // Directly on place page — scrape it
      scraped = await scrapeGymDetail(page, page.url());
    } else {
      // On list — try to click first result
      const firstResult = page.locator('a[href*="/maps/place/"]').first();
      if (await firstResult.isVisible({ timeout: 3000 }).catch(() => false)) {
        const href = await firstResult.getAttribute('href');
        if (href) {
          scraped = await scrapeGymDetail(page, href.split('?')[0]);
        }
      }
    }

    if (!scraped?.name) {
      // Fall back to using store locator data directly (no Google Maps enrichment)
      scraped = {
        name: location.name,
        address: location.address,
        lat: location.lat,
        lng: location.lng,
        phone: location.phone,
        website: location.website,
        category: 'gym',
        openingHours: [],
        reviews: [],
        photoUrls: [],
        rating: null,
        totalReviews: 0,
        googleMapsUrl: null,
        placeId: null,
      };
    }

    // Inject chain identity into scraped data
    const result = await processGym(scraped, areaName, jobId, true);

    // Tag with chain regardless of processGym result
    if (result.gymId) {
      await tagWithChain(result.gymId, chainId, chainSlug, chainName);
    }

    return result;

  } catch (err) {
    logger.warn(`  [ChainWorker] Enrich failed for "${location.name}": ${err.message}`);

    // Still insert using store locator data only
    const fallbackData = {
      name: location.name,
      address: location.address,
      lat: location.lat,
      lng: location.lng,
      phone: location.phone,
      website: location.website,
      category: 'gym',
      openingHours: [],
      reviews: [],
      photoUrls: [],
      googleMapsUrl: null,
      placeId: null,
    };

    const result = await processGym(fallbackData, areaName, jobId, false);
    if (result.gymId) {
      await tagWithChain(result.gymId, chainId, chainSlug, chainName);
    }
    return result;
  }
}

// ── Main chain job processor ──────────────────────────────────────────────────

async function processChainJob(job) {
  const { jobId, input } = job.data;
  const { chainSlug: slug, chainName, countries = [] } = input;
  const startTime = Date.now();

  await connectDB();
  await updateJob(jobId, { status: 'running', startedAt: new Date(), bullJobId: String(job.id) });
  bus.publish('job:started', { jobId, type: 'chain', chainSlug: slug, chainName });

  // Resolve or create the GymChain record
  let chain = await GymChain.findOne({ slug });
  if (!chain) {
    chain = await GymChain.create({ slug, name: chainName, isActive: true });
    logger.info(`[ChainWorker] Created new chain record: ${chainName}`);
  }
  const chainId = chain._id;

  const stats = { total: 0, skipped: 0, fresh: 0, created: 0, updated: 0, failed: 0, tagged: 0 };
  let stopReason = false;

  try {
    // ── Phase 1: Fetch all locations from store locator ─────────────────────
    logger.info(`\n🏋️  Chain crawl starting: ${chainName} [${slug}]`);

    const locator = require('../scraper/chainLocators').getLocator(slug);
    let locations;

    if (locator.chainSlug === 'osm-fallback') {
      // OSM fallback needs the chain name
      locations = await locator.fetchAllLocations(chainName);
    } else {
      locations = await locator.fetchAllLocations();
    }

    // Apply country filter if provided
    if (countries.length > 0) {
      const countrySet = new Set(countries.map(c => c.toUpperCase()));
      locations = locations.filter(l => {
        const code = (l.countryCode || l.country || '').toUpperCase();
        return countrySet.has(code) || countries.some(c =>
          (l.country || '').toLowerCase().includes(c.toLowerCase())
        );
      });
      logger.info(`[ChainWorker] Filtered to ${locations.length} locations in: ${countries.join(', ')}`);
    }

    stats.total = locations.length;
    await updateJob(jobId, { 'progress.total': stats.total });
    await job.updateProgress(10);

    logger.info(`[ChainWorker] 📋 ${stats.total} locations to process for ${chainName}`);

    if (!locations.length) {
      await updateJob(jobId, { status: 'completed', completedAt: new Date(), durationMs: Date.now() - startTime });
      return { summary: stats, jobId , status: 'completed' };
    }

    // ── Phase 2: Freshness check + classification ───────────────────────────
    const toInsert = [];
    const toUpdate = [];
    const toSkip = [];

    for (const loc of locations) {
      const check = await checkFreshness(loc);

      if (check.exists && check.isFresh) {
        // Fresh — skip scraping, just ensure chain tag
        if (check.needsChainTag) {
          await tagWithChain(check.gymId, chainId, slug, chainName);
          stats.tagged++;
        }
        stats.fresh++;
        toSkip.push(loc);
      } else if (check.exists && !check.isFresh) {
        // Stale — needs update via Google Maps enrichment
        toUpdate.push(loc);
      } else {
        // New — needs full insert
        toInsert.push(loc);
      }
    }

    logger.info(`[ChainWorker] Classification: ${toInsert.length} new, ${toUpdate.length} stale, ${toSkip.length} fresh-skipped, ${stats.tagged} chain-tagged`);
    stats.skipped = toSkip.length;

    await updateJob(jobId, {
      'progress.skipped': stats.skipped,
    });
    await job.updateProgress(20);

    // ── Phase 3: Process new + stale locations with Google Maps enrichment ──
    const toProcess = [...toInsert, ...toUpdate];

    if (!toProcess.length) {
      logger.info(`[ChainWorker] ✅ All locations already fresh. Nothing to scrape.`);
      await updateJob(jobId, {
        status: 'completed',
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      });
      // Update chain stats
      await updateChainStats(chainId, slug);
      return { summary: stats, jobId, status: 'completed' };
    }

    // Launch browser for Google Maps enrichment
    const browser = new BrowserManager();
    await browser.launch();

    // Process in parallel batches using p-limit
    const limit = pLimit(ENRICH_CONCURRENCY);
    let processed = 0;

    // Create a pool of pages for parallel scraping
    const pages = [];
    for (let i = 0; i < ENRICH_CONCURRENCY; i++) {
      pages.push(await browser.newPage());
    }
    let pageIdx = 0;

    const tasks = toProcess.map((location) => limit(async () => {
      // Check for cancellation
      stopReason = await shouldStop(jobId);
      if (stopReason) return;

      const page = pages[pageIdx % pages.length];
      pageIdx++;

      const areaName = [location.city, location.state, location.country].filter(Boolean).join(', ') || chainName;

      let result;
      let lastError;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          result = await enrichViaGoogleMaps(page, location, chainId, slug, chainName, areaName, jobId);
          break;
        } catch (err) {
          lastError = err;
          logger.warn(`  ⚠  [ChainWorker] Attempt ${attempt}/${MAX_RETRIES} for "${location.name}": ${err.message}`);
          if (attempt < MAX_RETRIES) await sleep(3000 * attempt, 5000 * attempt);
        }
      }

      processed++;
      await job.updateProgress(20 + Math.floor((processed / toProcess.length) * 80));

      if (!result || result.action === 'error') {
        stats.failed++;
        await updateJob(jobId, {
          $inc: { 'progress.failed': 1, errorCount: 1 },
          $push: { jobErrors: { message: lastError?.message || result?.error || 'enrichment failed', url: location.website || location.name, at: new Date() } },
        });
        return;
      }

      if (result.action === 'created') {
        stats.created++;
        await updateJob(jobId, {
          $inc: { 'progress.newGyms': 1, 'progress.scraped': 1 },
          $push: { gymIds: result.gymId },
        });
        bus.publish('gym:created', { name: location.name, area: areaName, gymId: String(result.gymId), chain: chainName });
      } else if (result.action === 'updated') {
        stats.updated++;
        await updateJob(jobId, {
          $inc: { 'progress.updatedGyms': 1, 'progress.scraped': 1 },
          $push: { gymIds: result.gymId },
        });
        bus.publish('gym:updated', { name: location.name, area: areaName, gymId: String(result.gymId), chain: chainName });
      } else if (result.action === 'skipped') {
        stats.skipped++;
        await updateJob(jobId, { $inc: { 'progress.skipped': 1 } });
      }

      await sleep(DELAY_MIN, DELAY_MAX);
    }));

    await Promise.all(tasks);
    await browser.close();

    // ── Phase 4: Finalize ────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime;

    let finalStatus;
    if (stopReason === 'cancelled') {
      finalStatus = 'cancelled';
      await clearCancelFlag(jobId);
    } else if (stopReason === 'shutdown') {
      finalStatus = 'partial';
    } else {
      finalStatus = (stats.failed > 0 && stats.created === 0 && stats.updated === 0) ? 'partial' : 'completed';
    }

    await updateJob(jobId, { status: finalStatus, completedAt: new Date(), durationMs });

    // Update chain stats
    await updateChainStats(chainId, slug);

    const emoji = finalStatus === 'cancelled' ? '🛑' : finalStatus === 'partial' ? '⚠️' : '✅';
    logger.info(`\n${emoji} Chain crawl done: ${chainName} — status:${finalStatus} new:${stats.created} updated:${stats.updated} fresh:${stats.fresh} skipped:${stats.skipped} failed:${stats.failed} tagged:${stats.tagged} (${(durationMs / 1000).toFixed(1)}s)`);

    bus.publish(finalStatus === 'cancelled' ? 'job:cancelled' : 'job:completed', {
      jobId, chainSlug: slug, chainName, status: finalStatus,
      ...stats, durationMs,
    });

    return { summary: stats, jobId, durationMs, status: finalStatus };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    await updateJob(jobId, { status: 'failed', completedAt: new Date(), durationMs });
    bus.publish('job:failed', { jobId, chainSlug: slug, chainName, error: err.message, durationMs });
    logger.error(`💥 Chain job FAILED [${chainName}]: ${err.message}`);
    throw err;
  }
}

// ── Update chain aggregate stats ──────────────────────────────────────────────

async function updateChainStats(chainId, chainSlug) {
  try {
    const count = await Gym.countDocuments({ chainSlug, isChainMember: true });
    const countries = await Gym.distinct('addressParts.country', { chainSlug, isChainMember: true });

    await GymChain.findByIdAndUpdate(chainId, {
      $set: {
        totalLocations: count,
        countriesPresent: countries.filter(Boolean),
        lastCrawledAt: new Date(),
      },
    });

    logger.info(`[ChainWorker] Updated chain stats: ${chainSlug} → ${count} locations, ${countries.filter(Boolean).length} countries`);
  } catch (err) {
    logger.warn(`[ChainWorker] Failed to update chain stats: ${err.message}`);
  }
}

// ── Worker startup ────────────────────────────────────────────────────────────

async function start() {
  await connectDB();

  // Seed chains from config if not already in DB
  try {
    const chainsConfig = require('../../config/chains.json');
    for (const chainData of chainsConfig) {
      await GymChain.findOneAndUpdate(
        { slug: chainData.slug },
        { $setOnInsert: chainData },
        { upsert: true, new: true },
      );
    }
    logger.info(`🌱 Chain seed: ${chainsConfig.length} chains ensured in DB`);
  } catch (err) {
    logger.warn(`Chain seed skipped: ${err.message}`);
  }

  const worker = new Worker('atlas-chain-crawl', async (job) => {
    logger.info(`⚙️  Processing chain job: ${job.name} [${job.id}]`);
    if (job.name === 'chain-crawl') return processChainJob(job);
    throw new Error(`Unknown chain job name: ${job.name}`);
  }, {
    connection,
    concurrency: CHAIN_CONCURRENCY,
    lockDuration: 7_200_000,   // 2 hours — chain jobs can be long
  });

  worker.on('completed', (job) => logger.info(`✅ Chain job completed: ${job.id}`));
  worker.on('failed',    (job, err) => logger.error(`❌ Chain job failed: ${job?.id} — ${err.message}`));
  worker.on('error',     (err) => logger.error(`Chain worker error: ${err.message}`));

  logger.info(`\n🏋️  Atlas Chain Worker started  [concurrency: ${CHAIN_CONCURRENCY}, enrich: ${ENRICH_CONCURRENCY}, freshness: ${FRESHNESS_DAYS}d]`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`\n⏳ Chain Worker received ${signal} — finishing current location(s) and shutting down...`);

    try { await worker.close(); } catch (_) {}

    logger.info('👋 Chain Worker shut down gracefully.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => { console.error('Chain Worker startup error:', err); process.exit(1); });
