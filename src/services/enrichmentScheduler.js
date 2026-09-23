'use strict';

/**
 * enrichmentScheduler.js — per-source enrichment schedule for every space
 *
 * Each space carries `enrichmentMeta.sources.<source>` state. A source can
 * claim a space when its `nextAt` is missing (never enriched) or due. Claims
 * are a single atomic findOneAndUpdate that pushes `nextAt` out by a lease, so
 * any number of lanes / worker processes can run without double-processing,
 * and a lane that dies mid-record releases it automatically when the lease
 * expires.
 *
 * Outcomes reschedule the record:
 *   success → nextAt = now + refresh interval (±10% jitter to spread load)
 *   failure → nextAt = now + 30min · 2^errors  (capped at MAX_BACKOFF)
 *   blocked → nextAt = now + BLOCK_RETRY, error count untouched (not the
 *             record's fault — Google is throttling us)
 *   skipped → nextAt = now + refresh interval (nothing to do for this source)
 *
 * Why not "oldest updatedAt first" (the previous design): updatedAt is touched
 * by crawls, dedup merges and failures alike, so the same records were picked
 * repeatedly, never-enriched records could starve, and a permanently failing
 * record came back every cycle.
 */

const Space = require('../db/spaceModel');

const DAY = 86_400_000;
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

const LEASE_MS       = num(process.env.ENRICH_LEASE_MS, 15 * 60_000);
const BASE_BACKOFF   = num(process.env.ENRICH_BACKOFF_BASE_MS, 30 * 60_000);
const MAX_BACKOFF    = num(process.env.ENRICH_BACKOFF_MAX_MS, 7 * DAY);
const BLOCK_RETRY_MS = num(process.env.ENRICH_BLOCK_RETRY_MS, 10 * 60_000);

/**
 * Source registry. `eligible` must include the partial-index predicate from
 * ensureIndexes.js ($type: 'string') so the claim query can use that index.
 */
const SOURCES = {
  google_maps: {
    label:     'Google Maps',
    refreshMs: num(process.env.ENRICH_GOOGLE_REFRESH_DAYS, 7) * DAY,
    weight:    num(process.env.ENRICH_GOOGLE_WEIGHT, 2),
    eligible:  { googleMapsUrl: { $type: 'string', $ne: '' }, permanentlyClosed: { $ne: true } },
  },
  website: {
    label:     'Official website',
    refreshMs: num(process.env.ENRICH_WEBSITE_REFRESH_DAYS, 30) * DAY,
    weight:    num(process.env.ENRICH_WEBSITE_WEIGHT, 1),
    eligible:  { 'contact.website': { $type: 'string', $regex: /^https?:\/\//i }, permanentlyClosed: { $ne: true } },
  },
};

const SOURCE_NAMES = Object.keys(SOURCES);
const path = (source, field) => `enrichmentMeta.sources.${source}.${field}`;
const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2));

const CLAIM_PROJECTION = {
  _id: 1, name: 1, areaName: 1, googleMapsUrl: 1, contact: 1, description: 1,
  pricing: 1, updatedAt: 1, enrichmentMeta: 1, opgId: 1,
};

/**
 * Atomically claim the next due space for `source`, or null if none is due.
 * Never-enriched records (nextAt missing) sort first, then most overdue.
 */
async function claimNext(source) {
  const def = SOURCES[source];
  if (!def) throw new Error(`Unknown enrichment source: ${source}`);
  const now = new Date();
  return Space.findOneAndUpdate(
    { ...def.eligible, [path(source, 'nextAt')]: { $not: { $gt: now } } },
    { $set: {
      [path(source, 'nextAt')]:      new Date(now.getTime() + LEASE_MS),
      [path(source, 'lastAttempt')]: now,
      [path(source, 'status')]:      'running',
    } },
    { sort: { [path(source, 'nextAt')]: 1 }, new: true, projection: CLAIM_PROJECTION, timestamps: false, lean: true }
  );
}

/** Claim a specific space for `source` (priority requests) — ignores nextAt. */
async function claimSpace(source, spaceId) {
  const now = new Date();
  return Space.findOneAndUpdate(
    { _id: spaceId },
    { $set: {
      [path(source, 'nextAt')]:      new Date(now.getTime() + LEASE_MS),
      [path(source, 'lastAttempt')]: now,
      [path(source, 'status')]:      'running',
    } },
    { new: true, projection: CLAIM_PROJECTION, timestamps: false, lean: true }
  );
}

async function markSuccess(source, spaceId, durationMs) {
  const now = new Date();
  await Space.updateOne({ _id: spaceId }, {
    $set: {
      [path(source, 'status')]:            'success',
      [path(source, 'lastSuccess')]:       now,
      [path(source, 'nextAt')]:            new Date(now.getTime() + jitter(SOURCES[source].refreshMs)),
      [path(source, 'consecutiveErrors')]: 0,
      [path(source, 'error')]:             null,
      [path(source, 'lastDurationMs')]:    durationMs,
      // Legacy roll-up read by the existing dashboard / data-health views
      'enrichmentMeta.lastAttempt':        now,
      'enrichmentMeta.lastSuccess':        now,
      'enrichmentMeta.status':             'success',
      'enrichmentMeta.consecutiveErrors':  0,
      'enrichmentMeta.error':              null,
    },
    $inc: { [path(source, 'runs')]: 1 },
  }, { timestamps: false });
}

/**
 * @param {object}  opts
 * @param {number}  opts.priorErrors  consecutiveErrors on the claimed record
 * @param {boolean} opts.blocked      Google throttled us — retry soon, don't penalise the record
 */
async function markFailure(source, spaceId, error, { priorErrors = 0, blocked = false, durationMs = null } = {}) {
  const now = new Date();
  const errors = blocked ? priorErrors : priorErrors + 1;
  const delay = blocked ? BLOCK_RETRY_MS : Math.min(BASE_BACKOFF * 2 ** Math.max(0, errors - 1), MAX_BACKOFF);
  await Space.updateOne({ _id: spaceId }, {
    $set: {
      [path(source, 'status')]:            'failed',
      [path(source, 'nextAt')]:            new Date(now.getTime() + jitter(delay)),
      [path(source, 'consecutiveErrors')]: errors,
      [path(source, 'error')]:             String(error || 'unknown').slice(0, 200),
      [path(source, 'lastDurationMs')]:    durationMs,
      'enrichmentMeta.lastAttempt':        now,
      'enrichmentMeta.status':             'failed',
      'enrichmentMeta.error':              String(error || 'unknown').slice(0, 200),
    },
    $inc: { [path(source, 'runs')]: 1 },
  }, { timestamps: false });
  return { nextInMs: delay, errors };
}

async function markSkipped(source, spaceId, reason) {
  const now = new Date();
  await Space.updateOne({ _id: spaceId }, {
    $set: {
      [path(source, 'status')]: 'skipped',
      [path(source, 'nextAt')]: new Date(now.getTime() + jitter(SOURCES[source].refreshMs)),
      [path(source, 'error')]:  reason ? String(reason).slice(0, 200) : null,
    },
  }, { timestamps: false });
}

/** Earliest future nextAt across sources — how long an idle lane may sleep. */
async function msUntilNextDue() {
  const now = new Date();
  let best = Infinity;
  for (const source of SOURCE_NAMES) {
    const doc = await Space.findOne(
      { ...SOURCES[source].eligible, [path(source, 'nextAt')]: { $gt: now } },
      { [path(source, 'nextAt')]: 1 }
    ).sort({ [path(source, 'nextAt')]: 1 }).lean();
    const at = doc?.enrichmentMeta?.sources?.[source]?.nextAt;
    if (at) best = Math.min(best, new Date(at).getTime() - now.getTime());
  }
  return best;
}

/**
 * Backlog per source for dashboards:
 *   eligible — records this source can enrich
 *   never    — never attempted by this source
 *   due      — ready to run now (includes never)
 *   failing  — ≥3 consecutive errors (on backoff)
 *   fresh    — eligible − due
 */
async function sourceBacklog() {
  const now = new Date();
  const out = {};
  await Promise.all(SOURCE_NAMES.map(async (source) => {
    const def = SOURCES[source];
    const [eligible, never, due, failing, running] = await Promise.all([
      Space.countDocuments(def.eligible),
      Space.countDocuments({ ...def.eligible, [path(source, 'nextAt')]: { $exists: false } }),
      Space.countDocuments({ ...def.eligible, [path(source, 'nextAt')]: { $not: { $gt: now } } }),
      Space.countDocuments({ ...def.eligible, [path(source, 'consecutiveErrors')]: { $gte: 3 } }),
      Space.countDocuments({ ...def.eligible, [path(source, 'status')]: 'running', [path(source, 'nextAt')]: { $gt: now } }),
    ]);
    out[source] = {
      label: def.label,
      refreshDays: +(def.refreshMs / DAY).toFixed(1),
      eligible, never, due, failing, running,
      fresh: Math.max(0, eligible - due),
    };
  }));
  return out;
}

module.exports = {
  SOURCES, SOURCE_NAMES,
  claimNext, claimSpace, markSuccess, markFailure, markSkipped,
  msUntilNextDue, sourceBacklog,
};
