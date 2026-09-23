'use strict';

/**
 * telemetry.js — live, per-process worker telemetry
 *
 * Every worker process (crawl, chain, enrichment) calls startHeartbeat() once.
 * Each HEARTBEAT_MS it:
 *   • writes a snapshot to Redis at atlas:telemetry:worker:<host:pid> with a
 *     TTL of 3 heartbeats — a crashed/hung worker simply disappears from the
 *     dashboard instead of looking "alive but idle" forever;
 *   • publishes `worker:heartbeat` on the event bus (→ SSE via the bridge).
 *
 * The API reads all live snapshots with listWorkers() for GET /api/system/pipeline.
 *
 * Building blocks for the snapshot:
 *   Meter          — rolling-window outcome counts, throughput/min, p50/p95 latency
 *   ActivityBoard  — "what is each browser page / lane doing right now"
 */

const os    = require('os');
const Redis = require('ioredis');
const cfg   = require('../../config');
const bus   = require('./eventBus');

const KEY_PREFIX   = 'atlas:telemetry:worker:';
const HEARTBEAT_MS = parseInt(process.env.TELEMETRY_HEARTBEAT_MS || '5000', 10);

let redis = null;
function getRedis() {
  if (!redis) {
    redis = new Redis({
      host: cfg.redis.host,
      port: cfg.redis.port,
      password: cfg.redis.password || undefined,
      // Queue commands while the lazily-created connection is still opening —
      // without it the API's first listWorkers() after boot always failed.
      // maxRetriesPerRequest still fails calls fast if Redis is really down.
      maxRetriesPerRequest: 1,
    });
    redis.on('error', () => {}); // telemetry is best-effort
  }
  return redis;
}

// ── Meter ────────────────────────────────────────────────────────────────────

class Meter {
  /** @param {number} windowMs rolling window used for rates and percentiles */
  constructor(windowMs = 5 * 60_000) {
    this.windowMs  = windowMs;
    this.startedAt = Date.now();
    this.samples   = [];   // { t, outcome, d }
    this.totals    = {};   // lifetime counts per outcome
  }

  /**
   * @param {string} outcome   e.g. 'created' | 'updated' | 'failed' | 'blocked'
   * @param {number} [durationMs]
   */
  mark(outcome, durationMs = null) {
    const now = Date.now();
    this.samples.push({ t: now, outcome, d: durationMs });
    this.totals[outcome] = (this.totals[outcome] || 0) + 1;
    this._trim(now);
  }

  _trim(now) {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i].t < cut) i++;
    if (i) this.samples.splice(0, i);
  }

  snapshot() {
    const now = Date.now();
    this._trim(now);
    const counts = {};
    const durs = [];
    for (const s of this.samples) {
      counts[s.outcome] = (counts[s.outcome] || 0) + 1;
      if (s.d != null) durs.push(s.d);
    }
    durs.sort((a, b) => a - b);
    const pct = (p) => (durs.length ? durs[Math.min(durs.length - 1, Math.floor(p * durs.length))] : null);
    // A process that started 40s ago must not report its rate over 5 minutes.
    const spanMin = Math.max(1 / 60, Math.min(this.windowMs, now - this.startedAt) / 60_000);
    return {
      windowMin: this.windowMs / 60_000,
      counts,
      perMin: +(this.samples.length / spanMin).toFixed(2),
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      totals: { ...this.totals },
    };
  }
}

// ── ActivityBoard ────────────────────────────────────────────────────────────

class ActivityBoard {
  constructor() { this.slots = new Map(); }

  /** Start a new activity on a slot (resets its timer). */
  set(slot, info) { this.slots.set(slot, { ...info, since: Date.now() }); }

  /** Patch the current activity without resetting its timer. */
  update(slot, patch) {
    const cur = this.slots.get(slot);
    if (cur) this.slots.set(slot, { ...cur, ...patch });
  }

  clear(slot) { this.slots.delete(slot); }

  list() {
    const now = Date.now();
    return [...this.slots.entries()].map(([slot, s]) => ({ slot, ...s, forMs: now - s.since }));
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * @param {string}   role       'crawl-worker' | 'chain-worker' | 'enrichment-worker'
 * @param {function} getExtra   returns (or resolves) role-specific snapshot fields
 * @returns {{ stop: () => Promise<void> }}
 */
function startHeartbeat(role, getExtra = () => ({})) {
  const startedAt = Date.now();
  const key = KEY_PREFIX + bus.instanceId;

  const tick = async () => {
    let extra = {};
    try { extra = (await getExtra()) || {}; } catch (_) {}
    const mem = process.memoryUsage();
    const snap = {
      instance:  bus.instanceId,
      role,
      pid:       process.pid,
      host:      os.hostname(),
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb:     Math.round(mem.rss / 1_048_576),
      heapMb:    Math.round(mem.heapUsed / 1_048_576),
      load1:     +os.loadavg()[0].toFixed(2),
      at:        new Date().toISOString(),
      ...extra,
    };
    try { await getRedis().set(key, JSON.stringify(snap), 'PX', HEARTBEAT_MS * 3); } catch (_) {}
    bus.publish('worker:heartbeat', snap);
  };

  tick();
  const timer = setInterval(tick, HEARTBEAT_MS);
  timer.unref();

  return {
    stop: async () => {
      clearInterval(timer);
      try { await getRedis().del(key); } catch (_) {}
    },
  };
}

/** All live worker snapshots (expired heartbeats are already gone). */
async function listWorkers() {
  const r = getRedis();
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await r.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  if (!keys.length) return [];
  const raws = await r.mget(keys);
  return raws
    .map(raw => { try { return JSON.parse(raw); } catch (_) { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.role.localeCompare(b.role) || a.instance.localeCompare(b.instance));
}

module.exports = { Meter, ActivityBoard, startHeartbeat, listWorkers, HEARTBEAT_MS };
