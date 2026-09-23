'use strict';

/**
 * eventBus.js — Central event emitter for Atlas
 *
 * All system events flow through this singleton. Consumers:
 *   - SSE endpoint (real-time browser push)
 *   - Webhook service (HTTP POST to external URLs)
 *   - Future: analytics, alerting, etc.
 *
 * Event types:
 *   job:queued      — Job added to BullMQ queue
 *   job:started     — Worker picked up a job
 *   job:progress    — Periodic progress update (every 10th space)
 *   job:completed   — Job finished successfully
 *   job:failed      — Job failed with error
 *   job:cancelled   — Job cancelled by user or shutdown
 *   space:created     — New space inserted into DB
 *   space:updated     — Existing space updated with new data
 *   schedule:fired  — Cron schedule triggered a crawl batch
 *   system:startup  — Server started
 */

const { EventEmitter } = require('events');
const os = require('os');

// Cross-process fan-out channel. The API server, crawl worker, chain worker
// and enrichment worker are separate Node processes, and this bus used to be
// a plain in-memory EventEmitter — so every crawl:* / enrichment:* event a
// worker published died inside that worker and never reached the dashboard's
// SSE stream. Workers now forward over Redis pub/sub; the API subscribes.
const BRIDGE_CHANNEL = 'atlas:events';
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

// High-frequency events that are useful live but would flush the 500-event
// history ring (and the dashboard's "recent" view) of everything meaningful.
const NO_HISTORY = new Set(['worker:heartbeat']);

class AtlasEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._history = [];       // Ring buffer of last 500 events
    this._maxHistory = 500;
    this._sseClients = new Set();
    this._role = null;
    this._pub = null;
  }

  get instanceId() { return INSTANCE_ID; }
  get role() { return this._role; }

  /**
   * Connect this process to the cross-process event bridge.
   *
   * @param {object} opts
   * @param {string} opts.role       Process label shown in the dashboard ('api', 'crawl-worker', …)
   * @param {boolean} [opts.subscribe] Receive events from other processes (the API server does)
   */
  enableBridge({ role, subscribe = false } = {}) {
    if (this._pub) return;
    this._role = role || 'process';
    try {
      const Redis = require('ioredis');
      const cfg = require('../../config');
      const opts = {
        host: cfg.redis.host,
        port: cfg.redis.port,
        password: cfg.redis.password || undefined,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false, // never buffer events while Redis is down
      };
      this._pub = new Redis(opts);
      this._pub.on('error', () => {}); // bridge is best-effort; never crash a worker

      if (subscribe) {
        const sub = new Redis({ ...opts, enableOfflineQueue: true });
        sub.on('error', () => {});
        sub.subscribe(BRIDGE_CHANNEL).catch(() => {});
        sub.on('message', (_ch, raw) => {
          try {
            const event = JSON.parse(raw);
            if (event?.origin?.instance === INSTANCE_ID) return; // our own echo
            this._deliver(event);
          } catch (_) {}
        });
      }
    } catch (_) {
      this._pub = null;
    }
  }

  /**
   * Emit a typed event and store in history.
   * @param {string} type — Event type (e.g. 'job:completed')
   * @param {object} data — Event payload
   */
  publish(type, data = {}) {
    const event = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type,
      data,
      timestamp: new Date().toISOString(),
      origin: { instance: INSTANCE_ID, role: this._role || 'process', pid: process.pid },
    };

    if (this._pub && this._pub.status === 'ready') {
      this._pub.publish(BRIDGE_CHANNEL, JSON.stringify(event)).catch(() => {});
    }
    this._deliver(event);
  }

  /** Local fan-out: history ring, in-process listeners, SSE clients. */
  _deliver(event) {
    if (NO_HISTORY.has(event.type)) {
      this.emit(event.type, event);
      this.emit('*', event);
      this._broadcastSSE(event);
      return;
    }

    // Store in ring buffer
    this._history.push(event);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Emit for internal listeners (webhook service, etc.)
    this.emit(event.type, event);
    this.emit('*', event); // Wildcard listener for SSE

    // Push to all connected SSE clients
    this._broadcastSSE(event);
  }

  /**
   * Get recent event history.
   * @param {number} limit — Max events to return
   * @param {string} [type] — Optional filter by event type
   */
  getHistory(limit = 50, type = null) {
    let events = this._history;
    if (type) events = events.filter(e => e.type === type);
    return events.slice(-limit);
  }

  // ── SSE Client Management ──────────────────────────────────────────────

  addSSEClient(res) {
    this._sseClients.add(res);
    res.on('close', () => this._sseClients.delete(res));
  }

  _broadcastSSE(event) {
    const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this._sseClients) {
      try { client.write(payload); } catch (_) { this._sseClients.delete(client); }
    }
  }

  get sseClientCount() {
    return this._sseClients.size;
  }
}

// Singleton export
const bus = new AtlasEventBus();
module.exports = bus;
