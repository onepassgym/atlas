'use strict';

/**
 * enrichmentService.js — Continuous Gym Enrichment Engine
 *
 * Manages a persistent enrichment loop that:
 *   1. Picks the oldest-updated gym from the DB (FIFO by updatedAt)
 *   2. Re-scrapes its Google Maps page for fresh data
 *   3. Updates the gym document with enriched details
 *   4. Moves to the next gym automatically
 *
 * Supports:
 *   - Pause / Resume via Redis flag  (dashboard button)
 *   - Priority Push: push a specific gymId to enrich next
 *   - SSE events: enrichment:started, enrichment:progress, enrichment:paused, etc.
 *   - Configurable batch size and inter-gym delay
 */

const Redis = require('ioredis');
const cfg = require('../../config');
const logger = require('../utils/logger');
const bus = require('./eventBus');

const REDIS_PAUSE_KEY   = 'atlas:enrichment:paused';
const REDIS_PRIORITY_KEY = 'atlas:enrichment:priority-queue';
const REDIS_STATUS_KEY  = 'atlas:enrichment:status';

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
    redis.connect().catch(() => {});
  }
  return redis;
}

// ── Pause / Resume ──────────────────────────────────────────────────────────

async function pauseEnrichment() {
  const r = getRedis();
  await r.set(REDIS_PAUSE_KEY, '1');
  await r.set(REDIS_STATUS_KEY, JSON.stringify({ state: 'paused', pausedAt: new Date().toISOString() }));
  logger.info('⏸️  Enrichment paused');
  bus.publish('enrichment:paused', { pausedAt: new Date().toISOString() });
}

async function resumeEnrichment() {
  const r = getRedis();
  await r.del(REDIS_PAUSE_KEY);
  await r.set(REDIS_STATUS_KEY, JSON.stringify({ state: 'running', resumedAt: new Date().toISOString() }));
  logger.info('▶️  Enrichment resumed');
  bus.publish('enrichment:resumed', { resumedAt: new Date().toISOString() });
}

async function isPaused() {
  try {
    const r = getRedis();
    const flag = await r.get(REDIS_PAUSE_KEY);
    return flag === '1';
  } catch (_) {
    return false;
  }
}

// ── Priority Queue ──────────────────────────────────────────────────────────
// LPUSH to add to front, RPOP to consume — gives LIFO for priority (latest push = next to process)

async function pushPriorityGym(gymId, gymName = '', sections = ['all']) {
  const r = getRedis();
  // Use LPUSH so the newest priority request runs first
  const validSections = ['all', 'reviews', 'photos', 'contact', 'hours', 'amenities', 'deep'];
  const cleanSections = (sections || ['all']).filter(s => validSections.includes(s));
  if (cleanSections.length === 0) cleanSections.push('all');

  await r.lpush(REDIS_PRIORITY_KEY, JSON.stringify({
    gymId, gymName, sections: cleanSections, pushedAt: new Date().toISOString(),
  }));
  logger.info(`⚡ Priority enrichment queued: ${gymName || gymId} [sections: ${cleanSections.join(', ')}]`);
  bus.publish('enrichment:priority-pushed', { gymId, gymName, sections: cleanSections });
}

async function popPriorityGym() {
  try {
    const r = getRedis();
    const item = await r.rpop(REDIS_PRIORITY_KEY);
    return item ? JSON.parse(item) : null;
  } catch (_) {
    return null;
  }
}

async function getPriorityQueueLength() {
  try {
    const r = getRedis();
    return await r.llen(REDIS_PRIORITY_KEY);
  } catch (_) {
    return 0;
  }
}

async function getPriorityQueue() {
  try {
    const r = getRedis();
    const items = await r.lrange(REDIS_PRIORITY_KEY, 0, -1);
    return items.map(i => JSON.parse(i));
  } catch (_) {
    return [];
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

async function setStatus(status) {
  const r = getRedis();
  await r.set(REDIS_STATUS_KEY, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }));
}

async function getStatus() {
  try {
    const r = getRedis();
    const raw = await r.get(REDIS_STATUS_KEY);
    if (!raw) return { state: 'idle', processedTotal: 0, processedToday: 0 };
    return JSON.parse(raw);
  } catch (_) {
    return { state: 'idle', processedTotal: 0, processedToday: 0 };
  }
}

async function getEnrichmentStats() {
  const status = await getStatus();
  const paused = await isPaused();
  const priorityLen = await getPriorityQueueLength();
  const priorityQueue = await getPriorityQueue();

  return {
    ...status,
    paused,
    priorityQueueLength: priorityLen,
    priorityQueue,
  };
}

module.exports = {
  pauseEnrichment,
  resumeEnrichment,
  isPaused,
  pushPriorityGym,
  popPriorityGym,
  getPriorityQueueLength,
  getPriorityQueue,
  setStatus,
  getStatus,
  getEnrichmentStats,
};
