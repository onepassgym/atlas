'use strict';
const Redis  = require('ioredis');
const cfg    = require('../../config');
const logger = require('../utils/logger');

const FAIL_THRESHOLD = 5; // consecutive failures before opening

// Cooldown before transitioning open → half-open (ms)
const COOLDOWN_MS = {
  google_maps: 1_800_000, // 30 min — session-level block is long-lived
  default:       900_000, // 15 min for other sources
};

// Extra cooldown if a half-open probe also fails
const HALF_OPEN_PENALTY_MS = 1_800_000; // 30 min

let _redis = null;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      host:     cfg.redis.host,
      port:     cfg.redis.port,
      password: cfg.redis.password || undefined,
      lazyConnect:          true,
      maxRetriesPerRequest: 2,
    });
    _redis.connect().catch(() => {});
  }
  return _redis;
}

function stateKey(source) { return `atlas:cb:${source}`; }

async function readState(source) {
  try {
    const raw = await getRedis().get(stateKey(source));
    return raw ? JSON.parse(raw) : { state: 'closed', failCount: 0 };
  } catch (_) {
    return { state: 'closed', failCount: 0 };
  }
}

async function writeState(source, data) {
  try {
    const ttl = (COOLDOWN_MS[source] || COOLDOWN_MS.default) + HALF_OPEN_PENALTY_MS + 120_000;
    await getRedis().set(stateKey(source), JSON.stringify(data), 'PX', ttl);
  } catch (_) {}
}

/**
 * Returns 'closed' | 'open' | 'half-open'.
 * Automatically transitions open → half-open when cooldown expires.
 */
async function check(source) {
  const data = await readState(source);
  if (data.state === 'closed') return 'closed';

  const cooldown = COOLDOWN_MS[source] || COOLDOWN_MS.default;
  const now = Date.now();

  if (data.state === 'open') {
    if ((data.openedAt + cooldown) <= now) {
      await writeState(source, { ...data, state: 'half-open', halfOpenAt: now });
      return 'half-open';
    }
    return 'open';
  }

  return data.state; // 'half-open'
}

async function recordSuccess(source) {
  const data = await readState(source);
  if (data.state !== 'closed') {
    logger.info(`[CircuitBreaker] ${source} → closed (recovered)`);
  }
  await writeState(source, { state: 'closed', failCount: 0 });
}

async function recordFailure(source, errorType = 'unknown') {
  const data    = await readState(source);
  const fails   = (data.failCount || 0) + 1;
  const isHalfOpen = data.state === 'half-open';

  if (isHalfOpen || fails >= FAIL_THRESHOLD) {
    // Adjust openedAt backward so the full cooldown restarts from now
    const openedAt = isHalfOpen
      ? Date.now() - (HALF_OPEN_PENALTY_MS)          // half-open failure → longer cooldown
      : Date.now();
    logger.warn(`[CircuitBreaker] ${source} → OPEN (${fails} failures, type:${errorType})`);
    await writeState(source, { state: 'open', failCount: fails, openedAt, errorType });
  } else {
    await writeState(source, { ...data, state: 'closed', failCount: fails });
  }
}

/** Force-open a circuit for a specific duration (used by sessionManager hourly budget). */
async function forceOpen(source, durationMs) {
  const openedAt = Date.now() - ((COOLDOWN_MS[source] || COOLDOWN_MS.default) - durationMs);
  logger.warn(`[CircuitBreaker] ${source} → OPEN (forced, ${Math.round(durationMs / 60000)}min)`);
  await writeState(source, { state: 'open', failCount: FAIL_THRESHOLD, openedAt, errorType: 'forced' });
}

async function getState(source) { return readState(source); }

module.exports = { check, recordSuccess, recordFailure, forceOpen, getState };
