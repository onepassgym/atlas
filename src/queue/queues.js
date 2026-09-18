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

/**
 * BullMQ de-duplicates on explicit job ids: adding a job whose id already
 * exists (including one still retained by removeOnComplete/removeOnFail)
 * returns the OLD job and enqueues nothing. The call looks successful, the API
 * reports "queued", and the job never runs — the classic
 * "job is in the queue but nothing happens" symptom. Detect it and say so.
 */
async function assertEnqueued(job, expectedId, label) {
  try {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      logger.error(
        `⚠️ Job id "${expectedId}" (${label}) already exists in state "${state}" — ` +
        `BullMQ returned the existing job and enqueued nothing. It will NOT run.`
      );
      return false;
    }
  } catch (_) {}
  return true;
}

const crawlQueue      = makeQueue('atlas-crawl');
const chainCrawlQueue = makeQueue('atlas-chain-crawl');
// Enrichment queue — targeted per-space enrichment jobs (Tasks 1-5)
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
  await assertEnqueued(job, jobId, `city ${cityName}`);
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


async function addSpaceNameJob(jobId, spaceName) {
  const job = await crawlQueue.add(
    'space-name-crawl',
    { type: 'space_name', jobId, input: { spaceName } },
    { jobId, priority: 1 }
  );
  await assertEnqueued(job, jobId, `space ${spaceName}`);
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
  const paused = await crawlQueue.isPaused().catch(() => null);
  return { waiting, active, completed, failed, delayed, paused };
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
 * Enqueue a space-enrichment job.
 * Input: { spaceId, placeUrl, cityName }
 * Priority 2 — below active city-crawls (priority 1).
 */
async function addEnrichmentJob(spaceId, placeUrl, cityName) {
  const jobId = `enrich:${spaceId}`;
  const job = await enrichmentQueue.add(
    'space-enrichment',
    { type: 'enrichment', spaceId: String(spaceId), input: { spaceId: String(spaceId), placeUrl, cityName } },
    { jobId, priority: 2, removeOnComplete: true }
  );
  logger.info(`📥 Queued enrichment: ${cityName || spaceId} space ${spaceId} (BullMQ #${job.id})`);
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
//
// opts: { jobId, delay, requeueCount } — used when requeueing the leftovers of
// a batch that stopped early, which needs a distinct id and a cooldown.
async function addBatchScrapeJob(parentJobId, cityName, urls, batchIndex, mode, opts = {}) {
  const batchJobId = opts.jobId || `${parentJobId}:batch:${batchIndex}`;
  const job = await crawlQueue.add(
    'batch-scrape',
    {
      type: 'batch',
      parentJobId,
      input: { cityName, urls, batchIndex, mode, requeueCount: opts.requeueCount || 0 },
    },
    { jobId: batchJobId, priority: 2, ...(opts.delay ? { delay: opts.delay } : {}) }
  );
  await assertEnqueued(job, batchJobId, `batch ${batchIndex} of ${cityName}`);
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

/**
 * Obliterate both crawl queues.
 *
 * obliterate() requires a paused queue and only deletes the `meta` key — which
 * holds the `paused` flag — on its final successful iteration. If it throws
 * partway (Redis hiccup, huge queue), the queue is left PAUSED with nothing to
 * un-pause it: every subsequently added job lands in the paused list and no
 * worker ever picks it up. Always resume, even on failure.
 */
async function clearCrawlQueue() {
  try {
    await crawlQueue.pause();
    await crawlQueue.obliterate({ force: true });
    await chainCrawlQueue.pause();
    await chainCrawlQueue.obliterate({ force: true });
  } finally {
    for (const q of [crawlQueue, chainCrawlQueue]) {
      try {
        if (await q.isPaused()) {
          await q.resume();
          logger.warn(`▶️ Resumed ${q.name} after clear (queue was left paused)`);
        }
      } catch (e) {
        logger.error(`Failed to resume ${q.name} after clear: ${e.message}`);
      }
    }
  }
}

/**
 * True when a queue is paused. A paused queue accepts jobs but never runs them,
 * so this is the first thing to check when jobs "just sit there".
 */
async function getPausedStates() {
  const [crawl, chain, enrichment] = await Promise.all([
    crawlQueue.isPaused().catch(() => null),
    chainCrawlQueue.isPaused().catch(() => null),
    enrichmentQueue.isPaused().catch(() => null),
  ]);
  return { crawl, chain, enrichment };
}

// ── Cancellation system (Redis-backed for fast polling) ──────────────────────
const {
  requestCancelJob,
  isJobCancelled,
  clearCancelFlag,
} = require('../services/jobCancelState');

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
 * Check whether any batch-scrape child jobs for a parent city/grid job are
 * still waiting, active, delayed, or prioritized in the queue. Used by
 * startup reconciliation to distinguish "still running across other worker
 * replicas" from "genuinely orphaned" — the parent discovery job itself
 * completes as soon as batches are enqueued, so its own BullMQ state can't
 * be used as the liveness signal once batching has started.
 */
async function hasPendingBatchJobs(jobId) {
  try {
    const batchPrefix = `${jobId}:batch:`;
    const states = ['waiting', 'active', 'delayed', 'prioritized'];
    const jobs = await crawlQueue.getJobs(states, 0, 500);
    return jobs.some(j => j.id && j.id.startsWith(batchPrefix));
  } catch (e) {
    // Fail safe: if we can't determine batch state, assume it might still be
    // running rather than risk falsely failing an in-progress job.
    logger.warn(`hasPendingBatchJobs check failed for ${jobId}: ${e.message}`);
    return true;
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
  redis,
  addCityJob,
  addGridJob,
  addSpaceNameJob,
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
  hasPendingBatchJobs,
  getPausedStates,
};
