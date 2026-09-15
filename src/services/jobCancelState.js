'use strict';

const Redis = require('ioredis');
const cfg = require('../../config');
const logger = require('../utils/logger');

let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis({
      host: cfg.redis.host,
      port: cfg.redis.port,
      password: cfg.redis.password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    redis.connect().catch((err) => {
      logger.warn(`Redis connection error in jobCancelState: ${err.message}`);
    });
  }
  return redis;
}

/**
 * Set a cancellation flag in Redis. The worker polls this mid-crawl.
 * TTL of 1 hour prevents stale flags from accumulating.
 */
async function requestCancelJob(jobId) {
  if (!jobId) return;
  try {
    const client = getRedis();
    await client.set(`atlas:cancel:${jobId}`, '1', 'EX', 3600);
    logger.info(`🛑 Cancel requested for job: ${jobId}`);
  } catch (err) {
    logger.error(`Failed to set cancel flag for job ${jobId}: ${err.message}`);
  }
}

/**
 * Check if a job has been flagged for cancellation.
 * Called by the worker in its scraping loops.
 */
async function isJobCancelled(jobId) {
  if (!jobId) return false;
  try {
    const client = getRedis();
    const flag = await client.get(`atlas:cancel:${jobId}`);
    return flag === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Clear the cancellation flag after the worker has handled it.
 */
async function clearCancelFlag(jobId) {
  if (!jobId) return;
  try {
    const client = getRedis();
    await client.del(`atlas:cancel:${jobId}`);
  } catch (_) {}
}

module.exports = {
  requestCancelJob,
  isJobCancelled,
  clearCancelFlag,
};
