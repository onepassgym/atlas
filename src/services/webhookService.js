'use strict';

/**
 * webhookService.js — HTTP webhook delivery for Atlas events
 *
 * Subscribes to the event bus and POSTs payloads to registered webhook URLs.
 * Retries up to 3 times with exponential backoff.
 * Webhook config stored in config/webhooks.json (runtime-editable via API).
 */

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const crypto = require('crypto');
const bus    = require('./eventBus');
const logger = require('../utils/logger');

const WEBHOOKS_PATH = path.resolve(__dirname, '../../config/webhooks.json');

// ── Load / Save ──────────────────────────────────────────────────────────────

function loadWebhooks() {
  try {
    if (fs.existsSync(WEBHOOKS_PATH)) {
      return JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf8'));
    }
  } catch (e) {
    logger.error('Failed to read webhooks.json:', e.message);
  }
  return { webhooks: [] };
}

function saveWebhooks(config) {
  fs.writeFileSync(WEBHOOKS_PATH, JSON.stringify(config, null, 2));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function getAll() {
  return loadWebhooks().webhooks;
}

function addWebhook({ url, events = ['*'], secret = null, name = '' }) {
  const config = loadWebhooks();
  const id = crypto.randomBytes(6).toString('hex');
  const webhook = {
    id,
    name: name || url,
    url,
    events,
    secret: secret || null,
    enabled: true,
    createdAt: new Date().toISOString(),
    stats: { sent: 0, failed: 0, lastSentAt: null },
  };
  config.webhooks.push(webhook);
  saveWebhooks(config);
  logger.info(`🪝 Webhook registered: ${url} → [${events.join(', ')}]`);
  return webhook;
}

function removeWebhook(id) {
  const config = loadWebhooks();
  const before = config.webhooks.length;
  config.webhooks = config.webhooks.filter(w => w.id !== id);
  if (config.webhooks.length === before) return false;
  saveWebhooks(config);
  return true;
}

function toggleWebhook(id, enabled) {
  const config = loadWebhooks();
  const wh = config.webhooks.find(w => w.id === id);
  if (!wh) return null;
  wh.enabled = enabled;
  saveWebhooks(config);
  return wh;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliverEvent(webhook, event) {
  const payload = {
    event: event.type,
    data: event.data,
    timestamp: event.timestamp,
    source: 'atlas',
  };

  // Sign payload if secret is set
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Atlas-Webhook/1.0' };
  if (webhook.secret) {
    const sig = crypto.createHmac('sha256', webhook.secret).update(JSON.stringify(payload)).digest('hex');
    headers['X-Atlas-Signature'] = `sha256=${sig}`;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(webhook.url, payload, { headers, timeout: 10000 });

      // Update stats
      const config = loadWebhooks();
      const wh = config.webhooks.find(w => w.id === webhook.id);
      if (wh) {
        wh.stats.sent = (wh.stats.sent || 0) + 1;
        wh.stats.lastSentAt = new Date().toISOString();
        saveWebhooks(config);
      }
      return true;
    } catch (err) {
      if (attempt === 3) {
        logger.warn(`🪝 Webhook delivery failed (${webhook.url}): ${err.message}`);
        const config = loadWebhooks();
        const wh = config.webhooks.find(w => w.id === webhook.id);
        if (wh) {
          wh.stats.failed = (wh.stats.failed || 0) + 1;
          saveWebhooks(config);
        }
        return false;
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ── Subscribe to event bus ───────────────────────────────────────────────────

function startWebhookService() {
  bus.on('*', async (event) => {
    const webhooks = loadWebhooks().webhooks.filter(w => {
      if (!w.enabled) return false;
      if (w.events.includes('*')) return true;
      return w.events.includes(event.type);
    });

    for (const wh of webhooks) {
      // Fire and forget — don't block the event bus
      deliverEvent(wh, event).catch(() => {});
    }
  });

  logger.info('🪝 Webhook service started');
}

module.exports = {
  getAll,
  addWebhook,
  removeWebhook,
  toggleWebhook,
  startWebhookService,
};
