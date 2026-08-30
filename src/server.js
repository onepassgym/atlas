'use strict';
require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
const path        = require('path');
const fs          = require('fs');
const { v4: uuidv4 } = require('uuid');

const { connectDB }   = require('./db/connection');
const indexRoutes     = require('./api/indexRoutes');
const crawlRoutes     = require('./api/crawlRoutes');
const spaceRoutes     = require('./api/spaceRoutes');
const chainRoutes     = require('./api/chainRoutes');
const enrichmentRoutes = require('./api/enrichmentRoutes');
const dataHealthRoutes = require('./api/dataHealthRoutes');
const systemRoutes    = require('./api/systemRoutes');
const mediaRoutes     = require('./api/mediaRoutes');
const { startScheduler } = require('./services/schedulerService');
const bus             = require('./services/eventBus');
const { startWebhookService } = require('./services/webhookService');
const cfg             = require('../config');
const logger          = require('./utils/logger');
const authMiddleware  = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1); // Enable trusting proxy headers for rate limiting


// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,  // Disabled: dashboard is a single-file internal tool
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('short', { 
  stream: { write: m => logger.info(m.trim()) },
  skip: (req) => req.path === '/api/events' || req.path.startsWith('/media/')
}));

// ── Rate limit ────────────────────────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: cfg.rateLimit.windowMs,
  max:      cfg.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
}));

// ── Static media ──────────────────────────────────────────────────────────────
const mediaPath = path.resolve(cfg.media.basePath);
fs.mkdirSync(mediaPath, { recursive: true });
app.use('/media', express.static(mediaPath, { maxAge: '7d' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/',           indexRoutes);
app.use('/docs',       require('./api/docsRoutes'));

// Base API authentication
app.use('/api',        authMiddleware);

app.use('/api/crawl',   crawlRoutes);
app.use('/api/spaces',  spaceRoutes);
app.use('/api/chains',  chainRoutes);
app.use('/api/system',  systemRoutes);
app.use('/api/enrichment', enrichmentRoutes);
app.use('/api/data-health', dataHealthRoutes);
app.use('/api/media',   mediaRoutes);
app.use('/api/events',  require('./api/eventRoutes'));

// ── Static files + Dashboard ──────────────────────────────────────────────────


// Serve Vite-built dashboard SPA
const dashboardPath = path.join(__dirname, '..', 'dashboard', 'dist');
app.use('/dashboard', express.static(dashboardPath, { maxAge: '7d' }));
app.get('/dashboard/*', (_, res) => res.sendFile(path.join(dashboardPath, 'index.html')));

// ── Error handlers ────────────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` })
);
app.use((err, req, res, _next) => {
  logger.error('Unhandled:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
(async () => {
  await connectDB();

  app.listen(cfg.server.port, async () => {
    logger.info(`\n${'─'.repeat(50)}`);
    logger.info(`🚀 Atlas API    →  http://localhost:${cfg.server.port}`);
    logger.info(`📦 Media files       →  http://localhost:${cfg.server.port}/media`);
    logger.info(`📊 Dashboard         →  http://localhost:${cfg.server.port}/dashboard`);
    logger.info(`📡 SSE events        →  http://localhost:${cfg.server.port}/api/events`);
    logger.info(`${'─'.repeat(50)}\n`);

    // Start services
    startScheduler();
    startWebhookService();

    // Seed space chains if not already in DB
    try {
      const SpaceChain = require('./db/spaceChainModel');
      const chainsConfig = require('../config/chains.json');
      let seeded = 0;
      for (const chainData of chainsConfig) {
        const result = await SpaceChain.findOneAndUpdate(
          { slug: chainData.slug },
          { $setOnInsert: chainData },
          { upsert: true, new: true, rawResult: true },
        );
        if (result.lastErrorObject?.updatedExisting === false) seeded++;
      }
      if (seeded > 0) logger.info(`🌱 Seeded ${seeded} new space chain(s)`);
    } catch (seedErr) {
      logger.warn(`Chain seed skipped: ${seedErr.message}`);
    }

    bus.publish('system:startup', { port: cfg.server.port, env: cfg.server.env });
  });
})();

module.exports = app;
