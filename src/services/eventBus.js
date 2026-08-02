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
 *   job:progress    — Periodic progress update (every 10th gym)
 *   job:completed   — Job finished successfully
 *   job:failed      — Job failed with error
 *   job:cancelled   — Job cancelled by user or shutdown
 *   gym:created     — New gym inserted into DB
 *   gym:updated     — Existing gym updated with new data
 *   schedule:fired  — Cron schedule triggered a crawl batch
 *   system:startup  — Server started
 */

const { EventEmitter } = require('events');

class AtlasEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._history = [];       // Ring buffer of last 500 events
    this._maxHistory = 500;
    this._sseClients = new Set();
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
    };

    // Store in ring buffer
    this._history.push(event);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Emit for internal listeners (webhook service, etc.)
    this.emit(type, event);
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
