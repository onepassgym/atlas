'use strict';

const SystemState = require('../db/systemStateModel');
const CrawlJob = require('../db/crawlJobModel');
const { isJobCancelled } = require('../services/jobCancelState');
const bus = require('../services/eventBus');
const logger = require('../utils/logger');

// ── SystemState TTL Cache (Gap 7) ─────────────────────────────────────────────
// Caches MongoDB system state for 30s to eliminate redundant DB reads during sleep()
let stateCache = {
  state: null,
  fetchedAt: 0,
};
const STATE_CACHE_TTL_MS = 30000;

async function getGlobalStateCached(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && stateCache.state && (now - stateCache.fetchedAt < STATE_CACHE_TTL_MS)) {
    return stateCache.state;
  }

  try {
    const fresh = await SystemState.getGlobalState();
    stateCache = {
      state: fresh || { crawlPace: 'normal', globalPause: false },
      fetchedAt: now,
    };
  } catch (_) {
    if (!stateCache.state) {
      stateCache = {
        state: { crawlPace: 'normal', globalPause: false },
        fetchedAt: now,
      };
    }
  }
  return stateCache.state;
}

function invalidateGlobalStateCache() {
  stateCache.fetchedAt = 0;
}

/**
 * Enhanced sleep supporting (min, max) or single (ms) argument.
 * Respects globalPause and crawlPace from cached SystemState.
 *
 * @param {number} min - Minimum delay ms (or fixed ms if max is omitted)
 * @param {number} [max] - Maximum delay ms
 * @param {function|boolean} [isShuttingDown] - Shutdown checker or boolean
 */
async function sleep(min, max, isShuttingDown = false) {
  const isDown = typeof isShuttingDown === 'function' ? isShuttingDown : () => Boolean(isShuttingDown);

  let state = await getGlobalStateCached();

  // Hold while globally paused
  while (state.globalPause && !isDown()) {
    await new Promise(r => setTimeout(r, 5000));
    // When paused, force fresh read so unpause is detected immediately
    state = await getGlobalStateCached(true);
  }

  let paceMultiplier = 1;
  if (state.crawlPace === 'slow') paceMultiplier = 3;
  if (state.crawlPace === 'fast') paceMultiplier = 0.5;

  const actualMin = min || 0;
  const actualMax = max !== undefined ? max : actualMin;
  const waitMs = (actualMin + Math.random() * (actualMax - actualMin)) * paceMultiplier;

  return new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * Random delay utility with no pace multiplier (for quick jitter/backoff).
 */
function randomDelay(min, max) {
  const waitMs = min + Math.random() * ((max || min) - min);
  return new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * Updates CrawlJob in MongoDB safely.
 */
async function updateJob(jobId, update) {
  try {
    await CrawlJob.findOneAndUpdate(
      { jobId },
      { ...update, $set: { ...(update.$set || {}), lastHeartbeatAt: new Date() } }
    );
  } catch (_) {}
}

/**
 * Check if a crawl/chain job should stop due to worker shutdown or cancellation.
 */
async function shouldStop(jobId, isShuttingDown = false) {
  const isDown = typeof isShuttingDown === 'function' ? isShuttingDown() : Boolean(isShuttingDown);
  if (isDown) return 'shutdown';
  try {
    if (await isJobCancelled(jobId)) return 'cancelled';
  } catch (_) {}
  return false;
}

// ── Adaptive Throttle System with Circuit Breaker (Gap 8) ────────────────────
// Dynamically adjusts inter-URL delay based on success/failure patterns.
// Trips circuit breaker after consecutive failures/blocks to prevent IP bans.

class AdaptiveThrottle {
  constructor(baseMin, baseMax, options = {}) {
    this.baseMin = baseMin;
    this.baseMax = baseMax;
    this.multiplier = 1.0;
    this.consecutiveSuccess = 0;
    this.consecutiveFails = 0;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold || 7;
    this.tripped = false;
    this.tripReason = null;
  }

  onSuccess(jobId) {
    const prevMultiplier = this.multiplier;
    this.consecutiveSuccess++;
    this.consecutiveFails = 0;
    this.tripped = false;
    this.tripReason = null;

    // Speed up slightly after 5+ consecutive successes (min multiplier 0.8)
    if (this.consecutiveSuccess >= 5) {
      this.multiplier = Math.max(0.8, this.multiplier - 0.05);
    }
    // Publish throttle change if multiplier shifted
    if (prevMultiplier !== this.multiplier && jobId) {
      bus.publish('crawl:throttle', {
        jobId,
        multiplier: this.multiplier,
        direction: 'faster',
        consecutiveSuccess: this.consecutiveSuccess,
      });
    }
  }

  onFailure(isBlock = false, jobId = null) {
    this.consecutiveFails++;
    this.consecutiveSuccess = 0;

    if (isBlock) {
      // Google actively blocking — slam the brakes
      this.multiplier = 4.0;
    } else {
      // Progressive slowdown: 1.5× → 2× → 3× → 4×
      this.multiplier = Math.min(4.0, 1.5 + (this.consecutiveFails * 0.5));
    }

    // Check circuit breaker threshold (Gap 8)
    if (this.consecutiveFails >= this.circuitBreakerThreshold) {
      this.tripped = true;
      this.tripReason = isBlock ? 'consecutive_blocks' : 'consecutive_failures';
      logger.error(`  🚨 [AdaptiveThrottle] Circuit breaker TRIPPED (${this.consecutiveFails} failures, reason: ${this.tripReason})`);
      if (jobId) {
        bus.publish('crawl:circuit_breaker', {
          jobId,
          consecutiveFails: this.consecutiveFails,
          reason: this.tripReason,
          multiplier: this.multiplier,
        });
      }
    }

    // Publish throttle change
    if (jobId) {
      bus.publish('crawl:throttle', {
        jobId,
        multiplier: this.multiplier,
        direction: 'slower',
        reason: isBlock ? 'google_block' : 'failure',
        consecutiveFails: this.consecutiveFails,
        tripped: this.tripped,
      });
    }
  }

  async wait(isShuttingDown = false) {
    const min = Math.round(this.baseMin * this.multiplier);
    const max = Math.round(this.baseMax * this.multiplier);
    await sleep(min, max, isShuttingDown);
  }

  get status() {
    const tripStr = this.tripped ? ' [TRIPPED]' : '';
    return `${this.multiplier.toFixed(2)}x (ok:${this.consecutiveSuccess} fail:${this.consecutiveFails})${tripStr}`;
  }

  reset() {
    this.multiplier = 1.0;
    this.consecutiveSuccess = 0;
    this.consecutiveFails = 0;
    this.tripped = false;
    this.tripReason = null;
  }
}

module.exports = {
  getGlobalStateCached,
  invalidateGlobalStateCache,
  sleep,
  randomDelay,
  updateJob,
  shouldStop,
  AdaptiveThrottle,
};
