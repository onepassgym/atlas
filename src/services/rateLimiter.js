'use strict';
const Redis  = require('ioredis');
const cfg    = require('../../config');
const logger = require('../utils/logger');

// Requests allowed per window per source
const SOURCE_LIMITS = {
  google_maps:  { requests: 1, windowMs: 3000  }, // conservative — free scraping
  osm_overpass: { requests: 1, windowMs: 6000  }, // 10 RPM respectful
  justdial:     { requests: 1, windowMs: 8000  }, // 7.5 RPM respectful
  yelp_scrape:  { requests: 1, windowMs: 10000 }, // 6 RPM respectful
  duckduckgo:   { requests: 1, windowMs: 5000  }, // 12 RPM respectful
};

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Acquire a rate-limit token for the given source.
 * Sleeps until the current window resets if the limit is exceeded.
 * Falls through silently if Redis is unavailable.
 */
async function acquire(source) {
  const limit = SOURCE_LIMITS[source];
  if (!limit) return;

  const redis   = getRedis();
  const windowStart = Math.floor(Date.now() / limit.windowMs);
  const key     = `atlas:rl:${source}:${windowStart}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // First request in this window — set TTL to clean up automatically
      await redis.pexpire(key, limit.windowMs + 500);
    }

    if (count > limit.requests) {
      const windowRemaining = (windowStart + 1) * limit.windowMs - Date.now();
      const jitter = Math.floor(Math.random() * limit.windowMs * 0.15);
      const waitMs = Math.max(100, windowRemaining + jitter);
      logger.debug(`[RateLimiter] ${source} over limit (${count}/${limit.requests}) — sleeping ${waitMs}ms`);
      await sleep(waitMs);
    }
  } catch (_) {
    // Redis unavailable — proceed without enforcement
  }
}

module.exports = { acquire, SOURCE_LIMITS };
