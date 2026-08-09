'use strict';
const CrawlRun = require('../db/crawlRunModel');
const bus      = require('./eventBus');
const logger   = require('../utils/logger');

const HISTORY_RUNS = 4;
const ZERO_YIELD_THRESHOLD = 10; // alert if history avg > 10 but current = 0
const RECORDS_GAP_THRESHOLD = 0.50;

/**
 * Post-run regression analysis. Called after each crawl_runs record is finalized.
 * Emits SSE events on detected regressions.
 */
async function checkRegression(runId) {
  const run = await CrawlRun.findOne({ runId }).lean();
  if (!run || !run.finishedAt) return;

  const history = await CrawlRun.find({
    locationOpgId: run.locationOpgId,
    categorySlug:  run.categorySlug,
    source:        run.source,
    finishedAt:    { $exists: true },
    runId:         { $ne: runId },
  })
    .sort({ startedAt: -1 })
    .limit(HISTORY_RUNS)
    .lean();

  if (!history.length) return;

  const avg = history.reduce((s, r) => s + (r.recordsFound || 0), 0) / history.length;
  const stats = run.httpStats || {};
  const blocked = (stats.blockDetectedCount || 0) > 0;

  // R1 — zero yield (not caused by a block)
  if (!blocked && run.recordsFound === 0 && avg > ZERO_YIELD_THRESHOLD) {
    bus.publish('crawl:regression', {
      severity: 'high', reason: 'zero_yield',
      locationOpgId: run.locationOpgId,
      categorySlug:  run.categorySlug,
      source:        run.source,
      historyAvg:    avg,
    });
    logger.warn(`[Observability] Zero-yield regression: ${run.locationOpgId}/${run.categorySlug} (hist avg=${avg.toFixed(1)})`);
  }

  // R2 — quota exhaustion (429s)
  if ((stats.s429Count || 0) > 5) {
    bus.publish('crawl:quota-warning', {
      severity: 'critical', source: run.source,
      count: stats.s429Count,
    });
  }

  // R3 — IP-level blocking (403s, not CAPTCHA-block)
  if (!blocked && (stats.s403Count || 0) > 10) {
    bus.publish('crawl:blocking-detected', {
      severity: 'high', source: run.source, reason: 'ip_403',
      locationOpgId: run.locationOpgId,
    });
  }

  // R4 — dedup/validation eating records
  const rawWritten = run.recordsRaw || 0;
  if (rawWritten > 10) {
    const entitiesWritten = (run.recordsNew || 0) + (run.recordsUpdated || 0);
    const dropRate = (rawWritten - entitiesWritten) / rawWritten;
    if (dropRate > RECORDS_GAP_THRESHOLD) {
      bus.publish('crawl:records-gap', {
        severity: 'medium', reason: 'dedup_or_validation_eating_records',
        rawWritten, entitiesWritten, dropRate: +dropRate.toFixed(2),
      });
    }
  }

  // R5 — CAPTCHA block with zero results (distinct from R1 — don't penalize consecutiveZeroRuns)
  if (blocked && run.recordsFound === 0 && avg > 0) {
    bus.publish('crawl:blocking-detected', {
      severity: 'high', source: run.source, reason: 'captcha_block',
      locationOpgId: run.locationOpgId,
    });
  }

  // R6 — session thrash
  if ((stats.sessionRotations || 0) > 3) {
    bus.publish('crawl:session-thrash', {
      severity: 'medium',
      locationOpgId: run.locationOpgId,
      rotations: stats.sessionRotations,
    });
  }
}

module.exports = { checkRegression };
