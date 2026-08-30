'use strict';

/**
 * eventRoutes.js — SSE event stream + webhook management API
 *
 * Endpoints:
 *   GET  /api/events          — Server-Sent Events stream (live)
 *   GET  /api/events/history  — Last N events from ring buffer
 *   GET  /api/events/stats    — SSE client count + event counts
 *   POST /api/webhooks        — Register a webhook
 *   GET  /api/webhooks        — List all webhooks
 *   DELETE /api/webhooks/:id  — Remove a webhook
 *   PATCH  /api/webhooks/:id  — Enable/disable a webhook
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const router  = express.Router();

const bus = require('../services/eventBus');
const { getAll, addWebhook, removeWebhook, toggleWebhook } = require('../services/webhookService');
const { ok, err, validate } = require('../utils/apiUtils');

// ── SSE Stream ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/events:
 *   get:
 *     summary: Server-Sent Events stream for real-time updates
 *     tags: [Events]
 *     responses:
 *       200:
 *         description: SSE event stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // Disable Nginx buffering
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to Atlas event stream', clients: bus.sseClientCount + 1 })}\n\n`);

  // keepalive ping every 30s
  const keepalive = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch (_) { clearInterval(keepalive); }
  }, 30000);

  bus.addSSEClient(res);

  req.on('close', () => {
    clearInterval(keepalive);
  });
});

// ── Event History ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/events/history:
 *   get:
 *     summary: Get recent event history
 *     tags: [Events]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by event type (e.g. job:completed)
 *     responses:
 *       200:
 *         description: Array of recent events
 */
router.get('/history',
  query('limit').optional().isInt({ min: 1, max: 200 }),
  query('type').optional().isString(),
  (req, res) => {
    if (validate(req, res)) return;
    const { limit = 50, type } = req.query;
    const events = bus.getHistory(+limit, type || null);
    ok(res, { count: events.length, events });
  }
);

// ── Event Stats ──────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  const history = bus.getHistory(200);
  const typeCounts = {};
  for (const e of history) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }
  ok(res, {
    sseClients: bus.sseClientCount,
    totalEvents: history.length,
    typeCounts,
  });
});

// ── Webhook CRUD ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/webhooks:
 *   post:
 *     summary: Register a webhook endpoint
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 example: "https://hooks.slack.com/services/xxx"
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["job:completed", "job:failed"]
 *               secret:
 *                 type: string
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Webhook registered
 */
router.post('/webhooks',
  body('url').isURL(),
  body('events').optional().isArray(),
  body('secret').optional().isString(),
  body('name').optional().isString(),
  (req, res) => {
    if (validate(req, res)) return;
    const wh = addWebhook(req.body);
    ok(res, { message: 'Webhook registered', webhook: wh }, 201);
  }
);

router.get('/webhooks', (req, res) => {
  const webhooks = getAll();
  ok(res, { count: webhooks.length, webhooks });
});

router.delete('/webhooks/:id',
  param('id').notEmpty(),
  (req, res) => {
    if (validate(req, res)) return;
    const removed = removeWebhook(req.params.id);
    if (!removed) return err(res, 'Webhook not found', 404);
    ok(res, { message: 'Webhook removed' });
  }
);

router.patch('/webhooks/:id',
  param('id').notEmpty(),
  body('enabled').isBoolean(),
  (req, res) => {
    if (validate(req, res)) return;
    const wh = toggleWebhook(req.params.id, req.body.enabled);
    if (!wh) return err(res, 'Webhook not found', 404);
    ok(res, { message: `Webhook ${wh.enabled ? 'enabled' : 'disabled'}`, webhook: wh });
  }
);

// ── Test event (for debugging) ───────────────────────────────────────────────

router.post('/test', (req, res) => {
  bus.publish('test:ping', {
    message: 'Test event from API',
    sentAt: new Date().toISOString(),
    ...req.body,
  });
  ok(res, { message: 'Test event published to all SSE clients and webhooks' });
});

module.exports = router;
