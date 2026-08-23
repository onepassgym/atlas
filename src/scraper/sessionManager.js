'use strict';
const Redis = require('ioredis');
const cfg   = require('../../config');
const cb    = require('../services/circuitBreaker');
const logger= require('../utils/logger');

const SESSION_URL_BUDGET  = cfg.scraper.sessionUrlBudget  || 40;
const BLOCK_COOLDOWN_MS   = cfg.scraper.blockCooldownMs   || 1_800_000; // 30 min
const HOURLY_BLOCK_BUDGET = cfg.scraper.hourlyBlockBudget || 2;
const HOUR_PAUSE_MS       = cfg.scraper.hourPauseMs       || 7_200_000; // 2 h

const STATE_KEY  = 'atlas:session:google_maps';
const HOURLY_KEY = 'atlas:session:google_maps:hourly_blocks';

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

async function getState() {
  try {
    const raw = await getRedis().get(STATE_KEY);
    return raw ? JSON.parse(raw) : { state: 'idle', urlsScraped: 0, blockCount: 0 };
  } catch (_) {
    return { state: 'idle', urlsScraped: 0, blockCount: 0 };
  }
}

async function setState(data) {
  try { await getRedis().set(STATE_KEY, JSON.stringify(data), 'EX', 10800); } catch (_) {}
}

/**
 * Check whether the current session needs rotation or is cooling down.
 * Returns { rotate: bool, cooling: bool }.
 */
async function shouldRotateSession() {
  const state = await getState();

  if (state.state === 'cooling') {
    if (state.coolUntil > Date.now()) return { rotate: false, cooling: true };
    // Cooldown expired — reset
    await setState({ state: 'idle', urlsScraped: 0, blockCount: 0 });
  }

  if ((state.urlsScraped || 0) >= SESSION_URL_BUDGET) {
    return { rotate: true, cooling: false };
  }

  return { rotate: false, cooling: false };
}

/** Call after successfully scraping a URL. */
async function reportUrlScraped() {
  const state = await getState();
  await setState({ ...state, state: 'active', urlsScraped: (state.urlsScraped || 0) + 1 });
  await cb.recordSuccess('google_maps');
}

/** Call when isBlocked() fires in the scraper. */
async function reportBlock() {
  const state = await getState();
  const redis = getRedis();

  let hourlyCount = 1;
  try {
    hourlyCount = await redis.incr(HOURLY_KEY);
    await redis.expire(HOURLY_KEY, 3600);
  } catch (_) {}

  logger.warn(`[SessionManager] Block detected — hourly count: ${hourlyCount}/${HOURLY_BLOCK_BUDGET}`);

  await cb.recordFailure('google_maps', 'captcha_block');

  if (hourlyCount > HOURLY_BLOCK_BUDGET) {
    await cb.forceOpen('google_maps', HOUR_PAUSE_MS);
    logger.warn('[SessionManager] Hourly block budget exceeded — Google Maps paused 2h');
  }

  await setState({
    state:       'cooling',
    urlsScraped: 0,
    blockCount:  (state.blockCount || 0) + 1,
    coolUntil:   Date.now() + BLOCK_COOLDOWN_MS,
  });
}

/** Returns false if Google Maps scraping is blocked (circuit open or session cooling). */
async function isAvailable() {
  const cbState = await cb.check('google_maps');
  if (cbState === 'open') return false;

  const session = await getState();
  if (session.state === 'cooling' && session.coolUntil > Date.now()) return false;

  return true;
}

/** Call when a new BrowserManager is launched to reset URL counter. */
async function markSessionLaunched() {
  await setState({ state: 'active', urlsScraped: 0, blockCount: 0, launchedAt: Date.now() });
}

/** Call on process start to clear any stale cooling state from a previous run. */
async function resetSession() {
  try {
    await getRedis().del(HOURLY_KEY);
    await setState({ state: 'idle', urlsScraped: 0, blockCount: 0 });
    await cb.recordSuccess('google_maps').catch(() => {});
    logger.info('[SessionManager] Session state cleared on startup');
  } catch (_) {}
}

module.exports = { shouldRotateSession, reportUrlScraped, reportBlock, isAvailable, markSessionLaunched, resetSession };
