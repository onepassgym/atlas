'use strict';

const cron = require('node-cron');

const logger = require('../utils/logger');
const bus = require('./eventBus');
const CrawlJob = require('../db/crawlJobModel');
const SystemState = require('../db/systemStateModel');
const {
  crawlQueue,
  chainCrawlQueue,
  enrichmentQueue,
  getPausedStates,
  redis, // shared client — reused here to serialize watchdog ticks across replicas
} = require('../queue/queues');
const { reconcileOrphanedJobs } = require('./jobReconciliationService');

const TICK_CRON = process.env.WATCHDOG_CRON || '*/3 * * * *';
const LOCK_KEY = 'atlas:watchdog:lock';
const LOCK_TTL_MS = 150000; // < the 3-minute tick interval, so a crashed tick self-heals

// No legitimate gap in the crawl loop (human-pause, block-cooldown, enrichment
// retry sleep, slow pace multiplier) approaches this — see workerUtils.js/
// worker.js sleep/backoff constants. Env-overridable for production tuning.
const STALE_WARN_MS = parseInt(process.env.WATCHDOG_STALE_WARN_MS || '600000', 10); // 10 min

async function acquireLock() {
  try {
    const res = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    return res === 'OK';
  } catch (e) {
    logger.warn(`[watchdog] Lock acquire failed: ${e.message}`);
    return false;
  }
}

async function checkPausedQueues() {
  const paused = await getPausedStates();
  const state = await SystemState.getGlobalState();
  const deliberate = state.pauseReason === 'operator';

  const queues = { crawl: crawlQueue, chain: chainCrawlQueue, enrichment: enrichmentQueue };
  for (const [name, isPaused] of Object.entries(paused)) {
    if (!isPaused) continue;

    // Operator only ever pauses crawl/chain via global-pause; enrichment is
    // never intentionally paused by any code path, so always resume it.
    if (name !== 'enrichment' && deliberate) {
      logger.info(`[watchdog] Queue "${name}" is paused (operator) — leaving as-is`);
      continue;
    }

    try {
      await queues[name].resume();
      logger.warn(`[watchdog] ▶️ Auto-resumed unattributed paused queue "${name}"`);
      bus.publish('watchdog:auto-resume', { queue: name, previousReason: state.pauseReason || 'unattributed' });
    } catch (e) {
      logger.error(`[watchdog] Failed to auto-resume queue "${name}": ${e.message}`);
    }
  }
}

async function checkStaleActiveJobs() {
  const [crawlActive, chainActive] = await Promise.all([
    crawlQueue.getJobs(['active'], 0, 100).catch(() => []),
    chainCrawlQueue.getJobs(['active'], 0, 100).catch(() => []),
  ]);

  const jobIds = [...crawlActive, ...chainActive]
    .map(j => j.id)
    .filter(id => id && !id.includes(':batch:')); // batch children don't carry their own CrawlJob doc

  if (!jobIds.length) return;

  const docs = await CrawlJob.find({ jobId: { $in: jobIds }, status: 'running' })
    .select('jobId lastHeartbeatAt input')
    .lean();

  const now = Date.now();
  for (const doc of docs) {
    const last = doc.lastHeartbeatAt ? new Date(doc.lastHeartbeatAt).getTime() : null;
    const staleSinceMs = last ? now - last : null;
    if (staleSinceMs !== null && staleSinceMs > STALE_WARN_MS) {
      logger.error(`[watchdog] ⚠️ Job ${doc.jobId} has no heartbeat for ${Math.round(staleSinceMs / 1000)}s — likely stalled`);
      bus.publish('watchdog:stale-job', {
        jobId: doc.jobId,
        staleSinceMs,
        cityName: doc.input?.cityName || doc.input?.regionName,
      });
    }
  }
}

async function tick() {
  const gotLock = await acquireLock();
  if (!gotLock) return; // another tick (this or another replica) is already running

  try {
    await checkPausedQueues();
    await reconcileOrphanedJobs();
    await checkStaleActiveJobs();
  } catch (e) {
    logger.error(`[watchdog] Tick failed: ${e.message}`);
  }
}

function startWatchdog() {
  cron.schedule(TICK_CRON, tick);
  logger.info(`🐕 Watchdog started: checking queue/job health every tick (${TICK_CRON})`);
}

module.exports = { startWatchdog, tick };
