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
// Dedicated media download queue — processed by mediaWorker.js
const mediaQueue      = makeQueue('atlas-media', {
  attempts:         3,
  backoff:          { type: 'exponential', delay: 3000 },
  removeOnComplete: 100,
  removeOnFail:     50,
});
// Enrichment queue — targeted per-space enrichment jobs
const enrichmentQueue = makeQueue('atlas-enrichment', {
  attempts:         2,
  backoff:          { type: 'exponential', delay: 8000 },
  removeOnComplete: 200,
  removeOnFail:     100,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function addCityJob(jobId, cityName, categories, skipRecentDays) {
  const job = await crawlQueue.add(
    'city-crawl',
    { type: 'city', jobId, input: { cityName, categories, skipRecentDays } },
    { jobId }
  );
  logger.info(`📥 Queued city: ${cityName} (BullMQ #${job.id})`);
  return job;
}

async function addGymNameJob(jobId, gymName) {
  const job = await crawlQueue.add(
    'gym-name-crawl',
    { type: 'gym_name', jobId, input: { gymName } },
    { jobId, priority: 1 }
  );
  logger.info(`📥 Queued gym name: ${gymName} (BullMQ #${job.id})`);
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

// Phase 5: enqueue media download for a single gym (non-blocking)
async function addMediaJob(gymId, slug, photoUrls) {
  if (!photoUrls?.length) return null;
  const job = await mediaQueue.add(
    'media-download',
    { gymId: String(gymId), slug, photoUrls },
    { jobId: `media:${gymId}`, removeOnComplete: true }
  );
  return job;
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

async function getMediaQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    mediaQueue.getWaitingCount(),
    mediaQueue.getActiveCount(),
    mediaQueue.getCompletedCount(),
    mediaQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

// Phase 3: scrape a fitness space by name (fan-out to all sources)
async function addSpaceNameJob(jobId, name, location, categories, deepCrossRef) {
  const job = await crawlQueue.add(
    'space-name-crawl',
    { type: 'space_name', jobId, input: { name, location, categories, deepCrossRef } },
    { jobId, priority: 1 }
  );
  logger.info(`📥 Queued space-name: "${name}" (BullMQ #${job.id})`);
  return job;
}

// Phase 3: scrape a fitness space from a direct URL (with optional cross-ref)
async function addSpaceUrlJob(jobId, url, deepCrossRef) {
  const job = await crawlQueue.add(
    'space-url-crawl',
    { type: 'space_url', jobId, input: { url, deepCrossRef } },
    { jobId, priority: 1 }
  );
  logger.info(`📥 Queued space-url: ${url.slice(0, 80)} (BullMQ #${job.id})`);
  return job;
}

// Phase 4: enqueue an enrichment graph stage advance for one space
async function addEnrichmentStageJob(spaceOpgId, targetStage) {
  const jobId = `enrich-stage:${spaceOpgId}:s${targetStage}`;
  const job = await enrichmentQueue.add(
    'enrichment-stage',
    { type: 'enrichment_stage', spaceOpgId, targetStage },
    { jobId, priority: 3, removeOnComplete: true }
  );
  return job;
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
  // Always resume so new jobs aren't stuck in the paused list
  await crawlQueue.resume();
  await chainCrawlQueue.resume();
}

async function pauseCrawlQueues() {
  await crawlQueue.pause();
  await chainCrawlQueue.pause();
}

async function resumeCrawlQueues() {
  await crawlQueue.resume();
  await chainCrawlQueue.resume();
}

async function getCrawlQueuePausedState() {
  const [crawlPaused, chainPaused] = await Promise.all([
    crawlQueue.isPaused(),
    chainCrawlQueue.isPaused(),
  ]);
  return { crawlPaused, chainPaused };
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
    const state = await job.getState();
    if (state === 'active') return 'already_active';
    if (state === 'waiting' || state === 'waiting-children' || state === 'delayed' || state === 'prioritized') {
      await job.changePriority({ priority: 0, lifo: false });
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
  mediaQueue,
  enrichmentQueue,
  addCityJob,
  addGymNameJob,
  addSpaceNameJob,
  addSpaceUrlJob,
  addChainJob,
  addMediaJob,
  addEnrichmentJob,
  addEnrichmentStageJob,
  addBatchScrapeJob,
  getQueueStats,
  getChainQueueStats,
  getMediaQueueStats,
  getEnrichmentQueueStats,
  getQueueJobStatus,
  getBullJobStatus: getQueueJobStatus,
  clearCrawlQueue,
  pauseCrawlQueues,
  resumeCrawlQueues,
  getCrawlQueuePausedState,
  requestCancelJob,
  isJobCancelled,
  clearCancelFlag,
  removeBullJob,
  removeJobAndBatches,
  promoteJobToFront,
};
