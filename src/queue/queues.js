'use strict';
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const cfg      = require('../../config');
const logger   = require('../utils/logger');

const connection = {
  host:     cfg.redis.host,
  port:     cfg.redis.port,
  password: cfg.redis.password,
};

// Shared Redis client for cancellation flags
const redis = new Redis({
  host:     cfg.redis.host,
  port:     cfg.redis.port,
  password: cfg.redis.password || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});
redis.connect().catch(() => {});

function makeQueue(name, jobOpts = {}) {
  const q = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts:         cfg.scraper.maxRetries,
      backoff:          { type: 'exponential', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail:     30,
      ...jobOpts,
    },
  });
  q.on('error', err => logger.error(`[${name}] Queue error: ${err.message}`));
  return q;
}

const crawlQueue      = makeQueue('atlas-crawl');
const chainCrawlQueue = makeQueue('atlas-chain-crawl');
// Enrichment queue — targeted per-gym enrichment jobs (Tasks 1-5)
const enrichmentQueue = makeQueue('atlas-enrichment', {
  attempts:         2,
  backoff:          { type: 'exponential', delay: 8000 },
  removeOnComplete: 200,
  removeOnFail:     100,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function addCityJob(jobId, cityName, categories) {
  const job = await crawlQueue.add(
    'city-crawl',
    { type: 'city', jobId, input: { cityName, categories } },
    { jobId }
  );
  logger.info(`📥 Queued city: ${cityName} (BullMQ #${job.id})`);
  return job;
}

async function addGridJob(jobId, regionName, lat, lng, zoom, categories) {
  const job = await crawlQueue.add(
    'grid-crawl',
    { type: 'grid', jobId, input: { regionName, lat, lng, zoom, categories } },
    { jobId }
  );
  logger.info(`📥 Queued grid tile for ${regionName} [${lat.toFixed(3)}, ${lng.toFixed(3)}] (BullMQ #${job.id})`);
  return job;
}


async function addGymNameJob(jobId, spaceName) {
  const job = await crawlQueue.add(
    'gym-name-crawl',
    { type: 'gym_name', jobId, input: { spaceName } },
    { jobId, priority: 1 }
  );
  logger.info(`📥 Queued space name: ${spaceName} (BullMQ #${job.id})`);
  return job;
}

async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    crawlQueue.getWaitingCount(),
    crawlQueue.getActiveCount(),
    crawlQueue.getCompletedCount(),
    crawlQueue.getFailedCount(),
    crawlQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

async function addChainJob(jobId, chainSlug, chainName, countries = []) {
  const job = await chainCrawlQueue.add(
    'chain-crawl',
    { type: 'chain', jobId, input: { chainSlug, chainName, countries } },
    { jobId, priority: 5 }
  );
  logger.info(`📥 Queued chain: ${chainName} [${chainSlug}] (BullMQ #${job.id})`);
  return job;
}

async function getChainQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    chainCrawlQueue.getWaitingCount(),
    chainCrawlQueue.getActiveCount(),
    chainCrawlQueue.getCompletedCount(),
    chainCrawlQueue.getFailedCount(),
    chainCrawlQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}


/**
 * Enqueue a gym-enrichment job.
 * Input: { gymId, placeUrl, cityName }
 * Priority 2 — below active city-crawls (priority 1).
 */
async function addEnrichmentJob(gymId, placeUrl, cityName) {
  const jobId = `enrich:${gymId}`;
  const job = await enrichmentQueue.add(
    'gym-enrichment',
    { type: 'enrichment', gymId: String(gymId), input: { gymId: String(gymId), placeUrl, cityName } },
    { jobId, priority: 2, removeOnComplete: true }
  );
  logger.info(`📥 Queued enrichment: ${cityName || gymId} gym ${gymId} (BullMQ #${job.id})`);
  return job;
}

async function getEnrichmentQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    enrichmentQueue.getWaitingCount(),
    enrichmentQueue.getActiveCount(),
    enrichmentQueue.getCompletedCount(),
    enrichmentQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}


// Phase 9: Enqueue a batch of URLs as a standalone scrape job.
// Multiple batches from the same city compete for any available worker replica.
async function addBatchScrapeJob(parentJobId, cityName, urls, batchIndex, mode) {
  const batchJobId = `${parentJobId}:batch:${batchIndex}`;
  const job = await crawlQueue.add(
    'batch-scrape',
    {
      type: 'batch',
      parentJobId,
      input: { cityName, urls, batchIndex, mode },
    },
    { jobId: batchJobId, priority: 2 }
  );
  return job;
}

async function getQueueJobStatus(jobId) {
  try {
    let job = await crawlQueue.getJob(jobId);
    if (!job) job = await chainCrawlQueue.getJob(jobId);
    if (!job) return null;
    return { 
      id: job.id, 
      state: await job.getState(), 
      progress: job.progress, 
      failedReason: job.failedReason 
    };
  } catch (_) { return null; }
}

async function clearCrawlQueue() {
  await crawlQueue.pause();
  await crawlQueue.obliterate({ force: true });
  await chainCrawlQueue.pause();
  await chainCrawlQueue.obliterate({ force: true });
}

// ── Cancellation system (Redis-backed for fast polling) ──────────────────────

/**
 * Set a cancellation flag in Redis. The worker polls this mid-crawl.
 * TTL of 1 hour prevents stale flags from accumulating.
 */
async function requestCancelJob(jobId) {
  await redis.set(`atlas:cancel:${jobId}`, '1', 'EX', 3600);
  logger.info(`🛑 Cancel requested for job: ${jobId}`);
}

/**
 * Check if a job has been flagged for cancellation.
 * Called by the worker in its scraping loops.
 */
async function isJobCancelled(jobId) {
  try {
    const flag = await redis.get(`atlas:cancel:${jobId}`);
    return flag === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Clear the cancellation flag after the worker has handled it.
 */
async function clearCancelFlag(jobId) {
  await redis.del(`atlas:cancel:${jobId}`);
}

/**
 * Remove a BullMQ job and all its possible batch children from the queue.
 */
async function removeJobAndBatches(jobId) {
  try {
    // 1. Remove the main job
    let mainJob = await crawlQueue.getJob(jobId);
    if (!mainJob) mainJob = await chainCrawlQueue.getJob(jobId);
    if (mainJob) await mainJob.remove().catch(() => {});

    // 2. Remove batches by scanning waiting/delayed jobs with matching prefix
    const batchPrefix = `${jobId}:batch:`;
    const states = ['waiting', 'delayed', 'active', 'failed'];
    for (const state of states) {
      const jobs = await crawlQueue.getJobs([state], 0, 500);
      for (const j of jobs) {
        if (j.id && j.id.startsWith(batchPrefix)) {
          await j.remove().catch(() => {});
        }
      }
    }
    return true;
  } catch (e) {
    logger.error(`Failed to remove job/batches for ${jobId}: ${e.message}`);
    return false;
  }
}

/**
 * Remove a BullMQ job if it's still waiting in the queue.
 */
async function removeBullJob(jobId) {
  try {
    let job = await crawlQueue.getJob(jobId);
    if (!job) job = await chainCrawlQueue.getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  } catch (_) { return false; }
}

/**
 * Promote a queued/waiting job to run immediately by setting its priority to 0
 * (BullMQ priority 0 = highest, runs before all other waiting jobs).
 * Returns: 'promoted' | 'already_active' | 'not_found'
 */
async function promoteJobToFront(jobId) {
  try {
    let job = await crawlQueue.getJob(jobId);
    if (!job) job = await chainCrawlQueue.getJob(jobId);
    if (!job) return 'not_found';

    const isPaused = await job.queue.isPaused();
    if (isPaused) {
      await job.queue.resume();
      logger.info(`▶️ Resumed paused queue before promoting job ${jobId}`);
    }

    const state = await job.getState();
    if (state === 'active') return 'already_active';
    if (state === 'waiting' || state === 'waiting-children' || state === 'delayed' || state === 'prioritized') {
      // Use highest priority and LIFO so the promoted job jumps ahead of same-priority waiting jobs.
      await job.changePriority({ priority: 0, lifo: true });
      logger.info(`⚡ Promoted job ${jobId} to front of queue`);
      return 'promoted';
    }
    return 'not_found';
  } catch (e) {
    logger.error(`Failed to promote job ${jobId}: ${e.message}`);
    throw e;
  }
}

module.exports = {
  crawlQueue,
  chainCrawlQueue,
  enrichmentQueue,
  addCityJob,
  addGridJob,
  addGymNameJob,
  addChainJob,
  addEnrichmentJob,
  addBatchScrapeJob,
  getQueueStats,
  getChainQueueStats,
  getEnrichmentQueueStats,
  getQueueJobStatus,
  getBullJobStatus: getQueueJobStatus,
  clearCrawlQueue,
  requestCancelJob,
  isJobCancelled,
  clearCancelFlag,
  removeBullJob,
  removeJobAndBatches,
  promoteJobToFront,
};
