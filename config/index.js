'use strict';
require('dotenv').config();

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production' || env === 'prod';

/**
 * Helper to pick env variable with fallback to DEV/PROD specific versions
 */
function getEnv(key, defaultValue) {
  const specificKey = isProd ? `PROD_${key}` : `DEV_${key}`;
  return process.env[key] || process.env[specificKey] || defaultValue;
}

module.exports = {
  server: {
    port: parseInt(process.env.PORT || '4060', 10),
    env:  env,
  },
  auth: {
    apiKeys: (process.env.API_KEYS || 'atlas_dev_secret').split(',').map(k => k.trim()).filter(Boolean),
  },
  mongo: {
    uri:    getEnv('MONGODB_URI', isProd ? 'mongodb://mongo:27017/atlas' : 'mongodb://127.0.0.1:27051/atlas'),
    dbName: process.env.MONGODB_DB_NAME || 'atlas',
  },
  redis: {
    host:     getEnv('REDIS_HOST', isProd ? 'redis' : '127.0.0.1'),
    port:     parseInt(getEnv('REDIS_PORT', isProd ? '6379' : '6847'), 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  scraper: {
    concurrency: parseInt(process.env.SCRAPER_CONCURRENCY || '1', 10),
    delayMin:    parseInt(process.env.SCRAPER_DELAY_MIN   || '3000',  10), // increased for anti-detection
    delayMax:    parseInt(process.env.SCRAPER_DELAY_MAX   || '6000', 10),
    timeout:     parseInt(process.env.SCRAPER_TIMEOUT     || '45000', 10),
    maxRetries:  parseInt(process.env.SCRAPER_MAX_RETRIES || '3', 10),
    headless:    process.env.SCRAPER_HEADLESS !== 'false',
    // Parallel browser tabs per batch job
    pagePool:       parseInt(process.env.SCRAPER_PAGE_POOL        || '3', 10),
    // Parallel pages for category search phase — 1 is safest for single IP
    searchPool:     parseInt(process.env.SCRAPER_SEARCH_POOL      || '1', 10),
    // Skip gyms crawled within N days (0 = disabled)
    skipRecentDays: parseInt(process.env.SCRAPER_SKIP_RECENT_DAYS || '7', 10),
    // URLs per batch-scrape job
    batchSize:      parseInt(process.env.SCRAPER_BATCH_SIZE       || '12', 10),
    // Max URLs to process in a gym-name crawl
    gymNameMaxUrls: parseInt(process.env.SCRAPER_GYM_NAME_MAX_URLS || '30', 10),
    // Phase 1c / Phase 4: depth caps per standard-mode scrape
    maxReviews:  parseInt(process.env.SCRAPER_MAX_REVIEWS || '30', 10),
    maxPhotos:   parseInt(process.env.SCRAPER_MAX_PHOTOS  || '20', 10),
    // Enrichment mode: deeper caps for NCR targeted pass
    enrichMaxReviews: parseInt(process.env.ENRICHMENT_MAX_REVIEWS || '500', 10),
    enrichMaxPhotos:  parseInt(process.env.ENRICHMENT_MAX_PHOTOS  || '500', 10),
    enrichBatchSize:  parseInt(process.env.ENRICHMENT_BATCH_SIZE  || '50',  10),
    userAgent:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Session management (free-scraping resilience)
    sessionUrlBudget:    parseInt(process.env.SCRAPER_SESSION_URL_BUDGET   || '40',      10),
    blockCooldownMs:     parseInt(process.env.SCRAPER_BLOCK_COOLDOWN_MS    || '1800000', 10), // 30 min
    hourlyBlockBudget:   parseInt(process.env.SCRAPER_HOURLY_BLOCK_BUDGET  || '2',       10),
    hourPauseMs:         parseInt(process.env.SCRAPER_HOUR_PAUSE_MS        || '7200000', 10), // 2 h
  },
  // ── Media download toggle (MEDIA_DOWNLOAD_ENABLED=false = URL capture only) ──
  // Default: false — all enrichment passes operate URL-capture-only.
  // Set to true in .env to re-enable Sharp/Axios downloads via downloader.js.
  media: {
    basePath:        process.env.MEDIA_BASE_PATH || './media',
    baseUrl:         getEnv('MEDIA_BASE_URL', isProd ? 'https://atlas.onepassgym.com/media' : `http://localhost:${process.env.PORT || '4060'}/media`),
    downloadEnabled: process.env.MEDIA_DOWNLOAD_ENABLED === 'true', // default false
  },
  dedup: {
    radiusMeters: parseInt(process.env.DEDUP_RADIUS_METERS || '50', 10),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max:      parseInt(process.env.RATE_LIMIT_MAX        || '100', 10),
  },
  // ── AI / LLM provider config ──────────────────────────────────────────────
  // Used by Stage 6 enrichment (amenity extraction, category classification,
  // description generation, sentiment analysis, embedding generation).
  ai: {
    provider:       process.env.AI_PROVIDER || 'openai',   // openai | anthropic
    openaiKey:      process.env.OPENAI_API_KEY || '',
    anthropicKey:   process.env.ANTHROPIC_API_KEY || '',
    // Model routing by task tier
    modelFast:      process.env.AI_MODEL_FAST    || 'gpt-4o-mini',  // high-volume tasks
    modelSmart:     process.env.AI_MODEL_SMART   || 'gpt-4o',       // complex extraction
    modelProse:     process.env.AI_MODEL_PROSE   || 'gpt-4o-mini',  // description generation
    // Safety caps per space per enrichment cycle
    maxCostPerSpace: parseFloat(process.env.AI_MAX_COST_PER_SPACE || '0.05'),
    cacheTtlSec:    parseInt(process.env.AI_CACHE_TTL_SEC || '86400', 10), // 24h Redis cache
    enabled:        process.env.AI_ENABLED !== 'false',
  },
  // ── External data source API keys ─────────────────────────────────────────
  sources: {
    yelpApiKey:    process.env.YELP_API_KEY || '',
    serpApiKey:    process.env.SERP_API_KEY || '',   // SerpAPI for Google Search
    serperKey:     process.env.SERPER_API_KEY || '', // Serper.dev alternative
    fbAccessToken: process.env.FB_ACCESS_TOKEN || '',
    // Proxy list for Google Maps scraping (comma-separated ip:port:user:pass)
    proxyList:     (process.env.PROXY_LIST || '').split(',').map(p => p.trim()).filter(Boolean),
  },
  log: {
    level: process.env.LOG_LEVEL || (isProd ? 'warn' : 'info'),
    dir:   process.env.LOG_DIR   || './logs',
  },
};
