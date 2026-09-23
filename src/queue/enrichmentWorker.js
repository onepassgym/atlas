'use strict';

/**
 * enrichmentWorker.js — Endless multi-source enrichment daemon
 *
 * NOTE (Architecture / Gap 12):
 * ATLAS contains two enrichment pathways:
 *   1. Standalone loop (this file, `npm run worker:enrich`): an autonomous daemon
 *      that continuously cycles every space through every enrichment source.
 *   2. BullMQ job handler (`worker.js` -> `enrichmentQueue`): queue-driven,
 *      one-off deep enrichment for explicitly triggered jobs.
 * Both use googleMapsScraper.js + enrichmentProcessor.js for consistent data.
 *
 * How the loop works
 * ──────────────────
 *   • Sources (services/enrichmentScheduler.js): `google_maps` (hours, rating,
 *     reviews, photos, amenities, socials) and `website` (emails, phones,
 *     socials, description, JSON-LD hours/price, photos). Each space keeps a
 *     separate schedule per source (`enrichmentMeta.sources.<src>.nextAt`).
 *   • ENRICHMENT_CONCURRENCY lanes run in parallel, each with its own browser.
 *     A lane rotates through sources by weight and atomically claims the next
 *     due record — no two lanes (or processes) ever take the same record.
 *   • Success → record comes back after the source's refresh interval.
 *     Failure → exponential backoff per record, so a dead website or a broken
 *     listing can't monopolise the loop. A Google block cools down ONLY the
 *     google source; lanes keep working the website source meanwhile.
 *   • Nothing due → sleep until the earliest nextAt (≤60s), then carry on.
 *     The loop never finishes; it is meant to run forever.
 *   • Priority pushes (dashboard "enrich now") pre-empt the schedule.
 *   • Respects enrichment pause and global pause.
 */

require('dotenv').config();

const { connectDB }   = require('../db/connection');
const SystemState     = require('../db/systemStateModel');
const EnrichmentLog   = require('../db/enrichmentLogModel');
const { BrowserManager, scrapeEnrichmentDetail, scrapeSelective } = require('../scraper/googleMapsScraper');
const { scrapeWebsiteDetails, classifySocialUrl, isBrowsableSite } = require('../scraper/websiteScraper');
const { processSpace } = require('../scraper/spaceProcessor');
const { processEnrichmentJob, processWebsiteEnrichment, recordSocialWebsite } = require('../scraper/enrichmentProcessor');
const { isPaused, popPrioritySpace, setStatus } = require('../services/enrichmentService');
const scheduler = require('../services/enrichmentScheduler');
const { Meter, ActivityBoard, startHeartbeat } = require('../services/telemetry');
const logger = require('../utils/logger');
const bus    = require('../services/eventBus');

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

const CONCURRENCY           = Math.max(1, int(process.env.ENRICHMENT_CONCURRENCY, 2));
const DELAY_BETWEEN_SPACES  = int(process.env.ENRICHMENT_DELAY, 1500);
const LOOP_MAX_REVIEWS      = int(process.env.ENRICHMENT_LOOP_MAX_REVIEWS, 60);
const LOOP_MAX_PHOTOS       = int(process.env.ENRICHMENT_LOOP_MAX_PHOTOS, 60);
const BROWSER_RECYCLE_AFTER = int(process.env.ENRICHMENT_BROWSER_RECYCLE, 150);
const GOOGLE_BLOCK_COOLDOWN = int(process.env.ENRICHMENT_BLOCK_COOLDOWN_MS, 180_000);
const MAX_ERRORS_BEFORE_COOLDOWN = 5;
const LANE_COOLDOWN_MS      = 60_000;
const PAUSE_POLL_INTERVAL   = 5000;
const IDLE_MIN_SLEEP_MS     = 5000;
const IDLE_MAX_SLEEP_MS     = 60_000;

let isShuttingDown = false;
let processedTotal = 0;
let processedToday = 0;
let todayDate = new Date().toISOString().slice(0, 10);
let googleCooldownUntil = 0;   // shared across lanes
let lastResult = null;         // { spaceName, source, action, duration }

const meters = Object.fromEntries(scheduler.SOURCE_NAMES.map(s => [s, new Meter()]));
const board  = new ActivityBoard();

// Weighted rotation, e.g. google_maps ×2, website ×1 → [g, g, w]
const SOURCE_ORDER = scheduler.SOURCE_NAMES.flatMap(s => Array(Math.max(0, Math.round(scheduler.SOURCES[s].weight))).fill(s));

/** Sleep that returns early on shutdown. */
async function nap(ms) {
  const end = Date.now() + ms;
  while (!isShuttingDown && Date.now() < end) {
    await new Promise(r => setTimeout(r, Math.min(500, end - Date.now())));
  }
}

function checkDayRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== todayDate) { todayDate = today; processedToday = 0; }
}

async function pausedNow() {
  const sys = await SystemState.getGlobalState().catch(() => ({ globalPause: false }));
  return (await isPaused()) || !!sys.globalPause;
}

// ── Lane ─────────────────────────────────────────────────────────────────────

class Lane {
  constructor(id) {
    this.id = id;
    this.slot = `lane${id}`;
    this.browser = null;
    this.tasksOnBrowser = 0;
    this.consecutiveErrors = 0;
    this.rr = (id - 1) % Math.max(1, SOURCE_ORDER.length); // stagger lanes across sources
  }

  async getBrowser() {
    if (this.browser && this.tasksOnBrowser >= BROWSER_RECYCLE_AFTER) {
      logger.info(`  ♻️  [lane ${this.id}] Recycling browser after ${this.tasksOnBrowser} tasks`);
      await this.closeBrowser();
    }
    if (!this.browser) {
      const b = new BrowserManager();
      await b.launch();
      this.browser = b;
      this.tasksOnBrowser = 0;
    }
    this.tasksOnBrowser++;
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) { try { await this.browser.close(); } catch (_) {} }
    this.browser = null;
  }
}

// ── Source runners ───────────────────────────────────────────────────────────

async function enrichFromGoogle(lane, space, { deep = false, sections = null } = {}) {
  const browser = await lane.getBrowser();
  const page = await browser.newPage();
  try {
    // Selective priority request (e.g. "reviews only") — legacy targeted path.
    if (sections && !sections.includes('all') && !sections.includes('deep')) {
      const scraped = await scrapeSelective(page, space.googleMapsUrl, sections);
      if (!scraped?.name) throw new Error('Could not extract space data from page');
      const res = await processSpace(scraped, space.areaName || '', `enrich:lane${lane.id}`, true);
      if (res.action === 'error') throw new Error(res.error || 'processSpace failed');
      return { action: res.action === 'skipped' ? 'unchanged' : 'enriched', changedFields: res.changedFields || [], newReviews: res.newReviews || 0, newPhotos: res.newPhotos || 0 };
    }

    const enriched = await scrapeEnrichmentDetail(
      page, space.googleMapsUrl,
      deep ? {} : { maxReviews: LOOP_MAX_REVIEWS, maxPhotos: LOOP_MAX_PHOTOS }
    );
    const res = await processEnrichmentJob(enriched, space._id, `enrich:lane${lane.id}`);
    if (res.action === 'error') throw new Error(res.error || 'processEnrichmentJob failed');
    const changed = res.changedFields || [];
    return {
      action: (changed.length || res.newReviews || res.newPhotos) ? 'enriched' : 'unchanged',
      changedFields: changed,
      newReviews: res.newReviews || 0,
      newPhotos: res.newPhotos || 0,
    };
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

async function enrichFromWebsite(lane, space) {
  const url = space.contact?.website;
  const social = classifySocialUrl(url);
  if (social) {
    const filed = await recordSocialWebsite(space._id, social, url);
    return {
      skipped: true, action: 'skipped',
      reason: `Listed website is a ${social} profile${filed ? ` — saved as contact.${social}` : ''}`,
      changedFields: filed ? [`contact.${social}`] : [], newReviews: 0, newPhotos: 0,
    };
  }
  if (!isBrowsableSite(url)) {
    return { skipped: true, action: 'skipped', reason: 'Listed website is a shortener / Google page', changedFields: [], newReviews: 0, newPhotos: 0 };
  }

  const browser = await lane.getBrowser();
  const details = await scrapeWebsiteDetails(browser.ctx, url);
  const res = await processWebsiteEnrichment(details, space._id);
  if (res.action === 'error') throw new Error(res.error);
  return { action: res.action, changedFields: res.changedFields, newReviews: 0, newPhotos: res.newPhotos };
}

const RUNNERS = { google_maps: enrichFromGoogle, website: enrichFromWebsite };

/**
 * Run one source against one (already claimed) space and record the outcome
 * in the schedule, the enrichment log, telemetry and the event bus.
 */
async function runSource(lane, source, space, opts = {}) {
  const t0 = Date.now();
  const spaceId = String(space._id);
  const spaceName = space.name || 'Unknown';
  const priorErrors = space.enrichmentMeta?.sources?.[source]?.consecutiveErrors || 0;
  const target = source === 'google_maps' ? space.googleMapsUrl : space.contact?.website;

  board.set(lane.slot, { kind: 'enrich', phase: source, source, target: spaceName, area: space.areaName || null, priority: !!opts.priority });
  bus.publish('enrichment:space-start', { spaceId, spaceName, source, lane: lane.id, priority: !!opts.priority, url: target, updatedAt: space.updatedAt });
  logger.info(`  🔄 [lane ${lane.id}] ${scheduler.SOURCES[source].label}: ${spaceName}${opts.priority ? ' [priority]' : ''}${priorErrors ? ` (after ${priorErrors} error(s))` : ''}`);

  try {
    const out = await RUNNERS[source](lane, space, opts);
    const duration = Date.now() - t0;

    if (out.skipped) await scheduler.markSkipped(source, space._id, out.reason);
    else await scheduler.markSuccess(source, space._id, duration);
    meters[source].mark(out.action, duration);

    EnrichmentLog.create({
      spaceId, spaceName, source,
      status: out.skipped ? 'skipped' : 'success',
      error: out.skipped ? out.reason : undefined,
      durationMs: duration, startedAt: new Date(t0), finishedAt: new Date(),
      fieldsUpdated: out.changedFields || [],
      photosAdded: out.newPhotos || 0,
      reviewsAdded: out.newReviews || 0,
    }).catch(e => logger.warn(`Failed to create enrichment log for ${spaceId}: ${e.message}`));

    processedTotal++; processedToday++;
    lane.consecutiveErrors = 0;
    lastResult = { spaceName, source, action: out.action, duration };

    bus.publish('enrichment:space-done', {
      spaceId, spaceName, source, lane: lane.id, action: out.action, reason: out.reason || null,
      changedFields: out.changedFields || [], newReviews: out.newReviews || 0, newPhotos: out.newPhotos || 0, duration,
    });
    logger.info(`  ✅ [lane ${lane.id}] ${source} ${spaceName} → ${out.action}${out.changedFields?.length ? ` [${out.changedFields.join(', ')}]` : ''} (+${out.newReviews || 0} rev, +${out.newPhotos || 0} photos, ${(duration / 1000).toFixed(1)}s)`);
    return { ok: true };
  } catch (err) {
    const duration = Date.now() - t0;
    const blocked = source === 'google_maps' && /Google blocked/i.test(err.message);
    const sched = await scheduler.markFailure(source, space._id, err.message, { priorErrors, blocked, durationMs: duration })
      .catch(() => ({ nextInMs: null, errors: priorErrors + 1 }));
    meters[source].mark(blocked ? 'blocked' : 'failed', duration);

    EnrichmentLog.create({
      spaceId, spaceName, source, status: 'failed', error: err.message,
      durationMs: duration, startedAt: new Date(t0), finishedAt: new Date(),
    }).catch(e => logger.warn(`Failed to create enrichment fail log for ${spaceId}: ${e.message}`));

    lane.consecutiveErrors++;
    lastResult = { spaceName, source, action: 'failed', duration };

    bus.publish('enrichment:space-failed', {
      spaceId, spaceName, source, lane: lane.id, blocked,
      error: err.message.slice(0, 160), duration,
      consecutiveErrors: sched.errors, retryInMs: sched.nextInMs,
    });
    logger.warn(`  ❌ [lane ${lane.id}] ${source} ${spaceName}: ${err.message} — retry in ${sched.nextInMs ? Math.round(sched.nextInMs / 60000) : '?'}min`);

    if (blocked) {
      googleCooldownUntil = Date.now() + GOOGLE_BLOCK_COOLDOWN;
      bus.publish('enrichment:cooldown', { source: 'google_maps', reason: 'google_block', cooldownMs: GOOGLE_BLOCK_COOLDOWN });
      logger.warn(`  🛑 Google block — pausing google_maps source for ${GOOGLE_BLOCK_COOLDOWN / 1000}s (website source continues)`);
    }
    return { ok: false, blocked };
  }
}

// ── Task selection ───────────────────────────────────────────────────────────

async function nextTask(lane) {
  // 1. Priority pushes from the dashboard / API
  const pri = await popPrioritySpace();
  if (pri) {
    const sections = pri.sections || ['all'];
    const space = await scheduler.claimSpace('google_maps', pri.spaceId).catch(() => null);
    if (space?.googleMapsUrl) return { priority: true, space, sections };
    logger.warn(`Priority space ${pri.spaceId} not found or has no Maps URL — skipping`);
  }

  // 2. Scheduled work, weighted rotation across sources
  for (let i = 0; i < SOURCE_ORDER.length; i++) {
    const source = SOURCE_ORDER[(lane.rr + i) % SOURCE_ORDER.length];
    if (source === 'google_maps' && Date.now() < googleCooldownUntil) continue;
    const space = await scheduler.claimNext(source);
    if (space) {
      lane.rr = (lane.rr + i + 1) % SOURCE_ORDER.length;
      return { source, space };
    }
  }
  return null;
}

async function runLane(lane) {
  while (!isShuttingDown) {
    checkDayRollover();

    if (await pausedNow()) {
      board.set(lane.slot, { kind: 'enrich', phase: 'paused', target: 'waiting for resume' });
      await lane.closeBrowser();
      while (!isShuttingDown && await pausedNow()) await nap(PAUSE_POLL_INTERVAL);
      continue;
    }

    let task;
    try {
      task = await nextTask(lane);
    } catch (err) {
      logger.warn(`  [lane ${lane.id}] Task selection failed: ${err.message}`);
      await nap(IDLE_MIN_SLEEP_MS);
      continue;
    }

    if (!task) {
      const wait = Math.max(IDLE_MIN_SLEEP_MS, Math.min(IDLE_MAX_SLEEP_MS, await scheduler.msUntilNextDue().catch(() => IDLE_MAX_SLEEP_MS)));
      const cooling = Date.now() < googleCooldownUntil;
      board.set(lane.slot, { kind: 'enrich', phase: 'idle', target: cooling ? 'google cooling down, nothing else due' : `all sources fresh — next due in ${Math.round(wait / 1000)}s` });
      await lane.closeBrowser(); // free memory while idle
      await nap(cooling ? Math.min(wait, googleCooldownUntil - Date.now() + 1000) : wait);
      continue;
    }

    try {
      if (task.priority) {
        const deep = task.sections.includes('deep');
        const selective = !task.sections.includes('all') && !deep;
        await runSource(lane, 'google_maps', task.space, { priority: true, deep, sections: selective ? task.sections : null });
        // A full priority request also refreshes the website source right away.
        if (!selective && task.space.contact?.website && /^https?:\/\//i.test(task.space.contact.website)) {
          const claimed = await scheduler.claimSpace('website', task.space._id);
          if (claimed) await runSource(lane, 'website', claimed, { priority: true });
        }
      } else {
        await runSource(lane, task.source, task.space);
      }
    } catch (err) {
      // runSource handles its own errors; this only guards bookkeeping failures.
      logger.error(`  [lane ${lane.id}] Unexpected error: ${err.stack || err.message}`);
      lane.consecutiveErrors++;
    }

    if (lane.consecutiveErrors >= MAX_ERRORS_BEFORE_COOLDOWN) {
      logger.warn(`  🛑 [lane ${lane.id}] ${lane.consecutiveErrors} consecutive errors — restarting browser + ${LANE_COOLDOWN_MS / 1000}s cooldown`);
      bus.publish('enrichment:cooldown', { lane: lane.id, errors: lane.consecutiveErrors, cooldownMs: LANE_COOLDOWN_MS });
      board.set(lane.slot, { kind: 'enrich', phase: 'cooldown', target: `${lane.consecutiveErrors} consecutive errors` });
      await lane.closeBrowser();
      await nap(LANE_COOLDOWN_MS);
      lane.consecutiveErrors = 0;
    }

    board.set(lane.slot, { kind: 'enrich', phase: 'between-records', target: '' });
    await nap(DELAY_BETWEEN_SPACES + Math.random() * DELAY_BETWEEN_SPACES * 0.5);
  }
  board.clear(lane.slot);
  await lane.closeBrowser();
}

// ── Status (legacy Redis key read by /api/enrichment/status) ─────────────────

function aggregateState() {
  const phases = board.list().map(s => s.phase);
  if (isShuttingDown) return 'stopping';
  if (phases.length && phases.every(p => p === 'paused')) return 'paused';
  if (phases.length && phases.every(p => p === 'idle')) return 'idle';
  return 'running';
}

async function publishStatus() {
  await setStatus({
    state: aggregateState(),
    processedTotal,
    processedToday,
    lanes: CONCURRENCY,
    lastSpace: lastResult?.spaceName,
    lastSource: lastResult?.source,
    lastAction: lastResult?.action,
    lastDuration: lastResult?.duration,
    googleCooldownMs: Math.max(0, googleCooldownUntil - Date.now()),
  }).catch(() => {});
}

// ── Main ─────────────────────────────────────────────────────────────────────

let heartbeat = null;
let lanePromises = [];

async function main() {
  bus.enableBridge({ role: 'enrichment-worker' });
  await connectDB();

  logger.info('\n🔁 Enrichment Worker started (endless, multi-source)');
  logger.info(`   • Lanes: ${CONCURRENCY}   • Source rotation: ${SOURCE_ORDER.join(' → ')}`);
  for (const s of scheduler.SOURCE_NAMES) {
    logger.info(`   • ${scheduler.SOURCES[s].label}: refresh every ${(scheduler.SOURCES[s].refreshMs / 86_400_000).toFixed(1)}d`);
  }
  logger.info(`   • Google depth per pass: ${LOOP_MAX_REVIEWS} reviews / ${LOOP_MAX_PHOTOS} photos`);
  logger.info(`   • Delay between records: ${DELAY_BETWEEN_SPACES}ms\n`);

  heartbeat = startHeartbeat('enrichment-worker', async () => {
    publishStatus();
    return {
      config: { lanes: CONCURRENCY, delayMs: DELAY_BETWEEN_SPACES, maxReviews: LOOP_MAX_REVIEWS, maxPhotos: LOOP_MAX_PHOTOS, rotation: SOURCE_ORDER },
      state: aggregateState(),
      activity: board.list(),
      sources: Object.fromEntries(Object.entries(meters).map(([s, m]) => [s, m.snapshot()])),
      googleCooldownMs: Math.max(0, googleCooldownUntil - Date.now()),
      processedTotal,
      processedToday,
    };
  });

  bus.publish('enrichment:started', { startedAt: new Date().toISOString(), lanes: CONCURRENCY });

  const lanes = Array.from({ length: CONCURRENCY }, (_, i) => new Lane(i + 1));
  lanePromises = lanes.map(async (lane) => {
    // Stagger lane start so browsers don't all launch in the same second.
    await nap((lane.id - 1) * 2000);
    // A lane must never die silently — restart it after any crash.
    while (!isShuttingDown) {
      try {
        await runLane(lane);
      } catch (err) {
        logger.error(`  💥 [lane ${lane.id}] crashed: ${err.stack || err.message} — restarting in 10s`);
        await lane.closeBrowser();
        await nap(10_000);
      }
    }
  });

  await Promise.all(lanePromises);
}

// ── Process lifecycle ────────────────────────────────────────────────────────

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`\n⏳ Received ${signal} — finishing in-flight records...`);
  const hardExit = setTimeout(() => process.exit(0), 25_000);
  hardExit.unref();
  try { await Promise.race([Promise.all(lanePromises), new Promise(r => setTimeout(r, 20_000))]); } catch (_) {}
  try { await heartbeat?.stop(); } catch (_) {}
  await setStatus({ state: 'stopped', processedTotal, processedToday }).catch(() => {});
  logger.info('👋 Enrichment Worker shut down gracefully.');
  process.exit(0);
};

// ── Crash guards ─────────────────────────────────────────────────────────────
// A stray async throw would otherwise kill this process outright with nothing
// in the winston logs, leaving the loop stopped with no one noticing.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection in enrichment worker: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception in enrichment worker: ${err?.stack || err?.message || err}`);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
  logger.error(`Enrichment Worker fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
