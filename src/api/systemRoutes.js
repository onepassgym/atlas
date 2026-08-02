'use strict';
const express = require('express');
const fs      = require('fs');
const fsp     = fs.promises;
const os      = require('os');
const path    = require('path');
const { body, query, validationResult } = require('express-validator');
const router  = express.Router();
const cfg     = require('../../config');
const logger  = require('../utils/logger');
const { ok, err, validate } = require('../utils/apiUtils');
const {
  getScheduleConfig,
  saveScheduleConfig,
  runScheduledCrawl,
  queueStaleGyms,
  queueIncompleteGyms,
  scheduleNCRCrawl,
  queueCity,
} = require('../services/schedulerService');
const Space = require('../db/spaceModel');
const { calculateQualityScore } = require('../services/intelligence/scoring');
const { analyzeGymSentiment } = require('../services/intelligence/sentiment');
const { Review } = require('../db/reviewModel');
const { crawlQueue, chainCrawlQueue, mediaQueue } = require('../queue/queues');
const SystemState = require('../db/systemStateModel');
const { runPhotoSync, getSyncStatus } = require('../services/photoSyncService');

const LOG_DIR = cfg.log.dir;
let lastCpuInfo = os.cpus();

/**
 * @swagger
 * tags:
 *   name: System
 *   description: Logging, scheduling, and utility operations
 */

/**
 * @swagger
 * /api/system/logs:
 *   get:
 *     summary: Retrieve log files or tail a specific log
 *     tags: [System]
 *     parameters:
 *       - in: query
 *         name: file
 *         schema:
 *           type: string
 *         description: Log filename (e.g. app-2026-04-12.log)
 *       - in: query
 *         name: tail
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Log content or index
 */
// GET /api/system/logs — lists all log files or tails a specific one
router.get('/logs',
  query('file').optional().trim(),
  query('tail').optional().isInt({ min: 1, max: 2000 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const { file, tail = 100 } = req.query;

    try {
      try {
        await fsp.access(LOG_DIR);
      } catch {
        return err(res, 'Log directory not found', 404);
      }

      const filesList = await fsp.readdir(LOG_DIR);
      const fileStats = await Promise.all(
        filesList
          .filter(f => f.endsWith('.log'))
          .map(async f => {
            const stats = await fsp.stat(path.join(LOG_DIR, f));
            return { name: f, stats };
          })
      );
      
      const files = fileStats
        .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
        .map(f => f.name);

      if (!file) {
        return ok(res, { 
          message: 'Specify ?file=filename to view content. Latest files listed below.',
          files: fileStats.map(f => ({
            name: f.name,
            size: (f.stats.size / 1024).toFixed(2) + ' KB',
            modified: f.stats.mtime
          }))
        });
      }

      // Security check: prevent directory traversal
      const safeFile = path.basename(file);
      const filePath = path.join(LOG_DIR, safeFile);

      try {
        await fsp.access(filePath);
      } catch {
        return err(res, 'File not found', 404);
      }

      const content = await fsp.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const resultLines = lines.slice(-tail);

      res.type('text/plain').send(resultLines.join('\n'));

    } catch (e) {
      logger.error('Log API error:', e);
      err(res, e.message);
    }
  }
);

// GET /api/system/media — lists all media files
router.get('/media', async (req, res) => {
  try {
    const mediaPath = path.resolve(cfg.media.basePath);
    try {
      await fsp.access(mediaPath);
    } catch {
      return ok(res, { files: [], totalSize: 0, message: 'Media directory not found or empty' });
    }
    
    const filesList = await fsp.readdir(mediaPath, { recursive: true });
    let totalSize = 0;
    
    const files = await Promise.all(
      filesList.map(async f => {
        const fullPath = path.join(mediaPath, f);
        try {
          const stats = await fsp.stat(fullPath);
          if (stats.isFile() && !f.startsWith('.') && !f.includes('/.')) {
             totalSize += stats.size;
             // Ensure URL is POSIX forward-slashed
             const urlPath = f.split(path.sep).join('/');
             return {
               name: path.basename(f),
               path: urlPath, // useful for full path reference
               url: `/media/${urlPath}`,
               size: stats.size,
               createdAt: stats.mtimeMs
             };
          }
        } catch (err) {
          return null; // Ignore unreadable files
        }
        return null;
      })
    );
    
    const validFiles = files.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    
    ok(res, {
      files: validFiles,
      totalSize,
      count: validFiles.length
    });
  } catch (e) {
    err(res, e.message);
  }
});

// GET /api/system/state
router.get('/state', async (req, res) => {
  try {
    const state = await SystemState.getGlobalState();
    ok(res, { state });
  } catch (e) { err(res, e.message); }
});

// GET /api/system/vps-stats
router.get('/vps-stats', async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memoryUsagePercent = (usedMem / totalMem) * 100;
    const currentCpuInfo = os.cpus();
    let idleDifference = 0;
    let totalDifference = 0;

    for (let i = 0; i < currentCpuInfo.length; i++) {
      const current = currentCpuInfo[i].times;
      const previous = lastCpuInfo[i] ? lastCpuInfo[i].times : current;
      const currentTotal = Object.values(current).reduce((acc, val) => acc + val, 0);
      const previousTotal = Object.values(previous).reduce((acc, val) => acc + val, 0);
      totalDifference += currentTotal - previousTotal;
      idleDifference += current.idle - previous.idle;
    }
    lastCpuInfo = currentCpuInfo;
    const cpuAvg = totalDifference === 0 ? 0 : 100 - (100 * idleDifference / totalDifference);

    ok(res, {
      vps: {
        memory: { total: totalMem, used: usedMem, free: freeMem, percent: memoryUsagePercent },
        cpu: { cores: currentCpuInfo.length, loadAvg: os.loadavg(), usagePercent: cpuAvg },
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch()
      }
    });
  } catch (e) { err(res, e.message); }
});

// POST /api/system/media/queue/pause
router.post('/media/queue/pause', async (req, res) => {
  try {
    await mediaQueue.pause();
    const state = await SystemState.getGlobalState();
    state.mediaQueuePaused = true;
    await state.save();
    ok(res, { message: 'Media downloading paused', state });
  } catch (e) {
    err(res, e.message);
  }
});

// POST /api/system/global-pause
router.post('/global-pause', express.json(), async (req, res) => {
  try {
    const { paused } = req.body;
    const state = await SystemState.getGlobalState();
    state.globalPause = !!paused;
    
    if (state.globalPause) {
      await crawlQueue.pause();
      await chainCrawlQueue.pause();
      await mediaQueue.pause();
      state.mediaQueuePaused = true;
      state.crawlQueuePaused = true;
    } else {
      await crawlQueue.resume();
      await chainCrawlQueue.resume();
      await mediaQueue.resume();
      state.mediaQueuePaused = false;
      state.crawlQueuePaused = false;
    }
    
    await state.save();
    ok(res, { message: state.globalPause ? 'System Standby Activated' : 'System Resumed', state });
  } catch (e) { err(res, e.message); }
});

// POST /api/system/pace
router.post('/pace', express.json(), async (req, res) => {
  try {
    const { pace } = req.body;
    if (!['slow', 'normal', 'fast'].includes(pace)) return err(res, 'Invalid pace', 400);
    const state = await SystemState.getGlobalState();
    state.crawlPace = pace;
    await state.save();
    ok(res, { message: `Crawl pace set to ${pace}`, state });
  } catch (e) { err(res, e.message); }
});

// POST /api/system/media/queue/resume
router.post('/media/queue/resume', async (req, res) => {
  try {
    await mediaQueue.resume();
    const state = await SystemState.getGlobalState();
    state.mediaQueuePaused = false;
    await state.save();
    ok(res, { message: 'Media downloading resumed', state });
  } catch (e) {
    err(res, e.message);
  }
});

// GET /api/system/logs/latest — shortcut to tail the latest app log
router.get('/logs/latest', async (req, res) => {
  try {
    const filesList = await fsp.readdir(LOG_DIR);
    const fileStats = await Promise.all(
      filesList
        .filter(f => f.startsWith('app-') && f.endsWith('.log'))
        .map(async f => {
          const stats = await fsp.stat(path.join(LOG_DIR, f));
          return { name: f, stats };
        })
    );
    
    fileStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

    if (!fileStats.length) return err(res, 'No app logs found', 404);

    const filePath = path.join(LOG_DIR, fileStats[0].name);
    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const tail = req.query.tail ? parseInt(req.query.tail) : 100;
    
    res.type('text/plain').send(lines.slice(-Math.min(tail, 1000)).join('\n'));
  } catch (e) {
    err(res, e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEDULE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/system/schedule:
 *   get:
 *     summary: View the full scheduling configuration
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Schedule config object
 */
// GET /api/system/schedule — view full schedule config
router.get('/schedule', async (req, res) => {
  try {
    const config = getScheduleConfig();
    ok(res, { schedule: config });
  } catch (e) {
    err(res, e.message);
  }
});

// POST /api/system/schedule — update full schedule config
router.post('/schedule', express.json(), async (req, res) => {
  try {
    const config = getScheduleConfig();
    const { cities, staleness, enrichment, defaultFrequency, timezone } = req.body;

    // Merge provided fields into existing config
    if (cities !== undefined) {
      if (!Array.isArray(cities)) return err(res, 'cities must be an array', 400);
      // Accept both string format and object format
      config.cities = cities.map(c => {
        if (typeof c === 'string') return { name: c, frequency: config.defaultFrequency || 'weekly', priority: 3 };
        return { name: c.name || c.city, frequency: c.frequency || config.defaultFrequency || 'weekly', priority: c.priority || 3 };
      });
    }
    if (staleness) config.staleness = { ...config.staleness, ...staleness };
    if (enrichment) config.enrichment = { ...config.enrichment, ...enrichment };
    if (defaultFrequency) config.defaultFrequency = defaultFrequency;
    if (timezone) config.timezone = timezone;

    saveScheduleConfig(config);
    logger.info(`Schedule updated: ${config.cities.length} cities configured`);
    ok(res, { message: 'Schedule updated successfully', schedule: config });
  } catch (e) {
    err(res, e.message);
  }
});

// POST /api/system/schedule/city — add a single city to the schedule
router.post('/schedule/city', express.json(),
  body('name').notEmpty().trim(),
  body('frequency').optional().isIn(['weekly', 'biweekly', 'monthly']),
  body('priority').optional().isInt({ min: 1, max: 10 }),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const config = getScheduleConfig();
      const { name, frequency = config.defaultFrequency || 'weekly', priority = 3 } = req.body;

      // Check if city already exists
      const exists = config.cities.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        // Update existing
        exists.frequency = frequency;
        exists.priority = priority;
      } else {
        config.cities.push({ name, frequency, priority });
      }

      saveScheduleConfig(config);
      ok(res, {
        message: exists ? `Updated "${name}" schedule` : `Added "${name}" to schedule`,
        city: { name, frequency, priority },
        totalCities: config.cities.length,
      });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/system/schedule/city:
 *   delete:
 *     summary: Remove a city from the schedule
 *     tags: [System]
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: City removed
 *       404:
 *         description: City not found
 */
// DELETE /api/system/schedule/city — remove a city from the schedule
router.delete('/schedule/city',
  query('name').notEmpty().trim(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const config = getScheduleConfig();
      const { name } = req.query;
      const before = config.cities.length;
      config.cities = config.cities.filter(c => c.name.toLowerCase() !== name.toLowerCase());

      if (config.cities.length === before) {
        return err(res, `City "${name}" not found in schedule`, 404);
      }

      saveScheduleConfig(config);
      ok(res, { message: `Removed "${name}" from schedule`, totalCities: config.cities.length });
    } catch (e) { err(res, e.message); }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEDULE TRIGGERS — manually fire scheduled operations
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/system/schedule/trigger:
 *   post:
 *     summary: Manually trigger a scheduled crawl
 *     tags: [System]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               frequency:
 *                 type: string
 *                 enum: [weekly, biweekly, monthly, all]
 *               city:
 *                 type: string
 *     responses:
 *       202:
 *         description: Crawl(s) queued
 */
// POST /api/system/schedule/trigger — trigger crawl by frequency
router.post('/schedule/trigger', express.json(),
  body('frequency').optional().isIn(['weekly', 'biweekly', 'monthly', 'all']),
  body('city').optional().isString().trim(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { frequency = 'all', city } = req.body;

      // If specific city provided, queue just that one
      if (city) {
        const jobId = await queueCity(city, 'manual-trigger');
        if (!jobId) return ok(res, { message: `City "${city}" already has an active job`, city }, 409);
        return ok(res, { message: `Crawl triggered for "${city}"`, jobId, trackAt: `/api/crawl/status/${jobId}` }, 202);
      }

      // Trigger by frequency
      let results;
      if (frequency === 'all') {
        results = await scheduleNCRCrawl('manual-trigger-all');
      } else {
        results = await runScheduledCrawl(frequency, 'manual-trigger');
      }

      ok(res, {
        message: `${results.length} cities queued for ${frequency} crawl`,
        jobs: results,
      }, 202);
    } catch (e) { err(res, e.message); }
  }
);

// POST /api/system/schedule/trigger/stale — re-crawl stale gyms
router.post('/schedule/trigger/stale', async (req, res) => {
  try {
    const results = await queueStaleGyms('manual-trigger');
    ok(res, {
      message: `${results.length} stale gyms queued for re-crawl`,
      jobs: results,
    }, 202);
  } catch (e) { err(res, e.message); }
});

// POST /api/system/schedule/trigger/enrichment — re-crawl incomplete gyms
router.post('/schedule/trigger/enrichment', async (req, res) => {
  try {
    const results = await queueIncompleteGyms('manual-trigger');
    ok(res, {
      message: `${results.length} incomplete gyms queued for enrichment re-crawl`,
      jobs: results,
    }, 202);
  } catch (e) { err(res, e.message); }
});

// POST /api/system/vacuum-logs — clear all log files
router.post('/vacuum-logs', async (req, res) => {
  try {
    const files = await fsp.readdir(LOG_DIR);
    let count = 0;
    for (const f of files) {
      if (f.endsWith('.log')) {
        await fsp.unlink(path.join(LOG_DIR, f));
        count++;
      }
    }
    logger.info(`Logs vacuumed: ${count} files removed`);
    ok(res, { message: `Logs vacuumed. Removed ${count} log files.` });
  } catch (e) { err(res, e.message); }
});

// POST /api/system/recalculate-scores — Bulk recalculate all gym scores/sentiment
router.post('/recalculate-scores', async (req, res) => {
  res.status(202).json({ success: true, message: 'Recalculation started in background' });
  
  // Run in background
  (async () => {
    try {
      const gyms = await Space.find({}).limit(5000); // Sanity limit
      logger.info(`Starting bulk recalculation for ${gyms.length} gyms...`);
      
      let processed = 0;
      for (const gym of gyms) {
        // Recalculate Quality Score
        const qScore = calculateQualityScore(gym);
        gym.qualityScore = qScore.score;
        gym.scoreBreakdown = qScore.breakdown;

        // Recalculate Sentiment
        const reviews = await Review.find({ gymId: gym._id }).lean();
        if (reviews.length > 0) {
          const sentiment = analyzeGymSentiment(reviews);
          gym.sentimentScore = sentiment.score;
          gym.sentimentTags = sentiment.tags;
        }

        await gym.save();
        processed++;
        if (processed % 100 === 0) {
           bus.publish('system:diag', { message: `Recalculated ${processed}/${gyms.length} gyms` });
           logger.info(`Recalculated ${processed}/${gyms.length} gyms`);
        }
      }
      logger.info(`Bulk recalculation completed for ${processed} gyms`);
      bus.publish('test:ping', { message: `✅ Recalculated ${processed} gym scores/sentiment` });
    } catch (e) {
      logger.error('Recalculation failed:', e);
    }
  })();
});

// ── POST /api/system/media/photo-sync/trigger — manual sync trigger ──────────
// Responds 202 immediately; runs the sync as a detached async job.
// If a sync is already running the lock prevents double execution.
router.post('/media/photo-sync/trigger', async (req, res) => {
  try {
    const status = await getSyncStatus();
    if (status.isLocked) {
      return res.status(409).json({
        success: false,
        message: `Sync already running (started by ${status.lockedBy} at ${status.lastRunAt?.toISOString()})`,
        status,
      });
    }

    // Respond immediately — don't await the sync
    res.status(202).json({ success: true, message: 'Photo sync started in background. Check /status for progress.' });

    runPhotoSync('manual').catch(e => {
      logger.error(`[system/photo-sync] Manual trigger error: ${e.stack || e}`);
    });
  } catch (e) {
    logger.error(`[system/photo-sync] Trigger error: ${e.message}`);
    err(res, e.message);
  }
});

// ── GET /api/system/media/photo-sync/status — rotation progress ──────────────
router.get('/media/photo-sync/status', async (req, res) => {
  try {
    const status = await getSyncStatus();
    ok(res, { status });
  } catch (e) {
    err(res, e.message);
  }
});

module.exports = router;

