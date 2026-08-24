'use strict';
const express  = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();

const {
  addCityJob, addGymNameJob, addSpaceNameJob, addSpaceUrlJob,
  getQueueStats, getMediaQueueStats, getQueueJobStatus,
  clearCrawlQueue, pauseCrawlQueues, resumeCrawlQueues, getCrawlQueuePausedState,
  requestCancelJob, removeBullJob, promoteJobToFront,
  removeJobAndBatches
} = require('../queue/queues');
const { FITNESS_CATEGORIES } = require('../scraper/googleMapsScraper');
const CrawlJob = require('../db/crawlJobModel');
const Space = require('../db/spaceModel');
const logger   = require('../utils/logger');

const { ok, err, validate } = require('../utils/apiUtils');
const bus = require('../services/eventBus');

// ── Job dedup helper — prevent duplicate city jobs ────────────────────────────
async function hasActiveJob(cityName) {
  const existing = await CrawlJob.findOne({
    'input.cityName': { $regex: new RegExp(`^${cityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    status: { $in: ['queued', 'running'] },
  }).lean();
  return existing;
}

/**
 * @swagger
 * tags:
 *   name: Crawl
 *   description: Gym and city crawling management
 */

/**
 * @swagger
 * /api/crawl/city:
 *   post:
 *     summary: Queue a city-wide crawl
 *     tags: [Crawl]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cityName]
 *             properties:
 *               cityName:
 *                 type: string
 *                 example: "Mumbai, Maharashtra, India"
 *               categories:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["gym", "fitness center"]
 *               force:
 *                 type: boolean
 *                 description: Bypass active job guard
 *                 example: false
 *     responses:
 *       202:
 *         description: Crawl queued successfully
 *       409:
 *         description: City already has an active job
 */
// POST /api/crawl/city
router.post('/city',
  body('cityName').notEmpty().trim(),
  body('categories').optional().isArray(),
  body('force').optional().isBoolean(),
  body('skipRecentDays').optional().isInt({ min: 0 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const { cityName, force = false } = req.body;
    const categories = Array.isArray(req.body.categories) ? req.body.categories : FITNESS_CATEGORIES;
    const skipRecentDays = req.body.skipRecentDays !== undefined ? Number(req.body.skipRecentDays) : undefined;

    try {
      // Job dedup guard
      if (!force) {
        const active = await hasActiveJob(cityName);
        if (active) {
          return ok(res, {
            message: `City "${cityName}" already has an active job (${active.status}). Use force:true to override.`,
            existingJobId: active.jobId,
            trackAt: `/api/crawl/status/${active.jobId}`,
          }, 409);
        }
      }

      const jobId = uuidv4();
      await CrawlJob.create({ jobId, type: 'city', input: { cityName, categories, skipRecentDays }, status: 'queued' });
      await addCityJob(jobId, cityName, categories, skipRecentDays);
      bus.publish('job:queued', { jobId, type: 'city', cityName, categoryCount: categories.length });
      ok(res, { message: `City crawl queued for "${cityName}"`, jobId, categoryCount: categories.length, trackAt: `/api/crawl/status/${jobId}` }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/crawl/gym:
 *   post:
 *     summary: Queue a crawl for a specific gym name
 *     tags: [Crawl]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gymName]
 *             properties:
 *               gymName:
 *                 type: string
 *                 example: "Gold's Gym Andheri Mumbai"
 *     responses:
 *       202:
 *         description: Gym crawl queued successfully
 */
// POST /api/crawl/gym
router.post('/gym',
  body('gymName').notEmpty().trim(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { gymName } = req.body;
    const jobId = uuidv4();
    try {
      await CrawlJob.create({ jobId, type: 'gym_name', input: { gymName }, status: 'queued' });
      await addGymNameJob(jobId, gymName);
      bus.publish('job:queued', { jobId, type: 'gym_name', gymName });
      ok(res, { message: `Gym crawl queued for "${gymName}"`, jobId, trackAt: `/api/crawl/status/${jobId}` }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/crawl/batch:
 *   post:
 *     summary: Queue crawls for multiple cities
 *     tags: [Crawl]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cities]
 *             properties:
 *               cities:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["Mumbai", "Delhi"]
 *               categories:
 *                 type: array
 *                 items:
 *                   type: string
 *               force:
 *                 type: boolean
 *     responses:
 *       202:
 *         description: Batch queued successfully
 */
// POST /api/crawl/batch
router.post('/batch',
  body('cities').isArray({ min: 1 }),
  body('cities.*').isString().notEmpty(),
  body('force').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { cities, force = false } = req.body;
    const categories = Array.isArray(req.body.categories) ? req.body.categories : FITNESS_CATEGORIES;
    const jobs = [];
    const skipped = [];
    try {
      for (const cityName of cities) {
        // Job dedup guard
        if (!force) {
          const active = await hasActiveJob(cityName);
          if (active) {
            skipped.push({ cityName, existingJobId: active.jobId, status: active.status });
            continue;
          }
        }
        const jobId = uuidv4();
        await CrawlJob.create({ jobId, type: 'city', input: { cityName, categories }, status: 'queued' });
        await addCityJob(jobId, cityName, categories);
        jobs.push({ cityName, jobId });
      }
      ok(res, { message: `${jobs.length} cities queued, ${skipped.length} skipped (already active)`, jobs, skipped }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/crawl/status/{jobId}:
 *   get:
 *     summary: Get status and progress of a crawl job
 *     tags: [Crawl]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job details
 *       404:
 *         description: Job not found
 */
// GET /api/crawl/status/:jobId
router.get('/status/:jobId', async (req, res) => {
  try {
    const db   = await CrawlJob.findOne({ jobId: req.params.jobId }).lean();
    if (!db) return err(res, 'Job not found', 404);
    const queueJob = await getQueueJobStatus(req.params.jobId);
    ok(res, { job: { ...db, queueJob } });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/crawl/jobs:
 *   get:
 *     summary: List all crawl jobs
 *     tags: [Crawl]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [queued, running, completed, failed, partial, cancelled]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *     responses:
 *       200:
 *         description: List of jobs
 */
// GET /api/crawl/jobs
router.get('/jobs',
  query('status').optional().isIn(['queued','running','completed','failed','partial','cancelled']),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('page').optional().isInt({ min: 1 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const { status, limit = 20, page = 1 } = req.query;
    const filter = status ? { status } : {};
    try {
      const [jobs, total] = await Promise.all([
        CrawlJob.find(filter).sort({ createdAt: -1 }).limit(+limit).skip((+page - 1) * +limit).lean(),
        CrawlJob.countDocuments(filter),
      ]);
      ok(res, { total, page: +page, limit: +limit, jobs });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/crawl/queue/stats:
 *   get:
 *     summary: Get BullMQ queue statistics
 *     tags: [Crawl]
 *     responses:
 *       200:
 *         description: Queue counts (waiting, active, completed, etc.)
 */
// GET /api/crawl/queue/stats
router.get('/queue/stats', async (req, res) => {
  try { ok(res, { queue: await getQueueStats(), mediaQueue: await getMediaQueueStats() }); }
  catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/crawl/cancel/{jobId}:
 *   post:
 *     summary: Request cancellation of a specific job
 *     description: Instantly cancels queued jobs. Signifies running jobs to stop after current item.
 *     tags: [Crawl]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Cancel request processed
 *       404:
 *         description: Job not found
 */
// POST /api/crawl/cancel/:jobId — cancel a specific job
router.post('/cancel/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const dbJob = await CrawlJob.findOne({ jobId }).lean();
    if (!dbJob) return err(res, 'Job not found', 404);

    if (dbJob.status === 'completed' || dbJob.status === 'cancelled') {
      return ok(res, { message: `Job is already ${dbJob.status}`, jobId, status: dbJob.status });
    }

    // Set Redis cancel flag — worker checks this every URL iteration
    await requestCancelJob(jobId);

    if (dbJob.status === 'queued') {
      await removeJobAndBatches(jobId);
      await CrawlJob.findOneAndUpdate({ jobId }, { status: 'cancelled', completedAt: new Date() });
      return ok(res, { message: 'Queued job cancelled and removed', jobId, status: 'cancelled' });
    }

    await CrawlJob.findOneAndUpdate({ jobId }, { status: 'cancelled', completedAt: new Date() });
    ok(res, { message: 'Job cancellation requested. Workers will stop shortly.', jobId, status: 'cancelled' });

  } catch (e) { err(res, e.message); }
});

// POST /api/crawl/force-complete/:jobId — Instantly stop and mark as completed
router.post('/force-complete/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const dbJob = await CrawlJob.findOne({ jobId }).lean();
    if (!dbJob) return err(res, 'Job not found', 404);

    // 1. Set status in DB
    await CrawlJob.findOneAndUpdate({ jobId }, { status: 'completed', completedAt: new Date() });

    // 2. Signal workers to stop
    await requestCancelJob(jobId);

    // 3. Clean up queue
    await removeJobAndBatches(jobId);

    bus.publish('job:completed', { jobId, cityName: dbJob.input?.cityName, status: 'completed', forced: true });
    
    ok(res, { message: 'Job force-completed and removed from queue. Progress is locked.', jobId, status: 'completed' });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/crawl/start-now/{jobId}:
 *   post:
 *     summary: Immediately promote a queued job to the front of the queue
 *     description: Changes the BullMQ job priority to 0 (highest) so it runs next, ahead of all other waiting jobs.
 *     tags: [Crawl]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job promoted to front
 *       400:
 *         description: Job is already running or not in a promotable state
 *       404:
 *         description: Job not found
 */
// POST /api/crawl/start-now/:jobId — promote a queued job to run immediately
router.post('/start-now/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const dbJob = await CrawlJob.findOne({ jobId }).lean();
    if (!dbJob) return err(res, 'Job not found', 404);

    if (dbJob.status !== 'queued') {
      return ok(res, {
        message: `Job cannot be promoted — current status is "${dbJob.status}". Only queued jobs can be started immediately.`,
        jobId,
        status: dbJob.status,
      }, 400);
    }

    const result = await promoteJobToFront(jobId);

    if (result === 'not_found') {
      // BullMQ job missing but DB says queued — edge case, job may have already been picked up
      return ok(res, {
        message: 'Job not found in the BullMQ queue — it may have already been picked up by a worker.',
        jobId,
        status: dbJob.status,
      }, 400);
    }

    if (result === 'already_active') {
      return ok(res, { message: 'Job is already being processed by a worker.', jobId, status: 'running' });
    }

    bus.publish('job:promoted', { jobId, type: dbJob.type, cityName: dbJob.input?.cityName, gymName: dbJob.input?.gymName });
    logger.info(`⚡ Job ${jobId} promoted to front via API`);
    return ok(res, {
      message: `Job promoted to front of queue — it will start on the next available worker.`,
      jobId,
      promoted: true,
    });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/crawl/queue/clear:
 *   post:
 *     summary: Obliterate all jobs in the queue
 *     tags: [Crawl]
 *     responses:
 *       200:
 *         description: Queue cleared and active jobs marked cancelled
 */
// POST /api/crawl/queue/clear
router.post('/queue/clear', async (req, res) => {
  try {
    await clearCrawlQueue();
    // Also reset any 'queued' or 'running' jobs in the DB
    const result = await CrawlJob.updateMany(
      { status: { $in: ['queued', 'running'] } },
      { status: 'cancelled', completedAt: new Date() }
    );
    ok(res, { message: `Queue obliterated. ${result.modifiedCount} job(s) cancelled.` });
  } catch (e) { err(res, e.message); }
});

// POST /api/crawl/queue/pause — pause both crawl queues (workers stop picking new jobs)
router.post('/queue/pause', async (req, res) => {
  try {
    await pauseCrawlQueues();
    ok(res, { message: 'Crawl queues paused. Workers will finish current jobs but not start new ones.' });
  } catch (e) { err(res, e.message); }
});

// POST /api/crawl/queue/resume — resume paused crawl queues
router.post('/queue/resume', async (req, res) => {
  try {
    await resumeCrawlQueues();
    ok(res, { message: 'Crawl queues resumed.' });
  } catch (e) { err(res, e.message); }
});

// GET /api/crawl/queue/paused — returns whether queues are paused
router.get('/queue/paused', async (req, res) => {
  try {
    const state = await getCrawlQueuePausedState();
    ok(res, state);
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/crawl/retry/failed:
 *   post:
 *     summary: Re-queue all failed/partial city jobs
 *     tags: [Crawl]
 *     responses:
 *       200:
 *         description: Retry jobs queued
 */
// POST /api/crawl/retry/failed
router.post('/retry/failed', async (req, res) => {
  try {
    const failed = await CrawlJob.find({ status: { $in: ['failed','partial'] }, type: 'city' }).lean();
    if (!failed.length) return ok(res, { message: 'No failed or partial jobs found' });
    
    // Surface the coverage gap per city
    const gapSummary = failed.map(j => ({
      cityName: j.input.cityName,
      discovered: j.progress?.total || 0,
      scraped: j.progress?.scraped || 0,
      failed: j.progress?.failed || 0,
      blocked: j.progress?.blockedCount || 0,
      gap: (j.progress?.total || 0) - (j.progress?.scraped || 0) - (j.progress?.skipped || 0),
    }));

    const jobs = [];
    for (const j of failed) {
      const jobId = uuidv4();
      await CrawlJob.create({ jobId, type: 'city', input: j.input, status: 'queued' });
      await addCityJob(jobId, j.input.cityName, j.input.categories || []);
      jobs.push({ cityName: j.input.cityName, jobId });
    }
    logger.info(`Re-queued ${failed.length} failed jobs via API`);
    ok(res, { message: `Re-queued ${failed.length} failed jobs`, jobs, gapSummary });
  } catch (e) { err(res, e.message); }
});

// POST /api/crawl/retry/incomplete
router.post('/retry/incomplete',
  body('threshold').optional().isInt({ min: 1, max: 99 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const threshold = req.body.threshold || 50;
    try {
      const { addEnrichmentJob } = require('../queue/queues');
      const spaces = await Space.find({
        deletedAt: null,
        dataCompleteness: { $lt: threshold },
        'enrichment.status': { $ne: 'quarantined' },
        googleMapsUrl: { $exists: true, $ne: null },
      }).select('name areaName city googleMapsUrl dataCompleteness').sort({ dataCompleteness: 1 }).limit(200).lean();

      if (!spaces.length) return ok(res, { message: `No spaces found with completeness < ${threshold}%` });

      const jobs = [];
      for (const s of spaces) {
        await addEnrichmentJob(s._id, s.googleMapsUrl, s.city || s.areaName);
        jobs.push({ name: s.name, spaceId: String(s._id), completeness: s.dataCompleteness });
      }
      logger.info(`Queued ${spaces.length} incomplete spaces for enrichment via API`);
      ok(res, { message: `Queued ${spaces.length} incomplete spaces for enrichment`, jobs });
    } catch (e) { err(res, e.message); }
});

// GET /api/crawl/coverage — Phase 2: crawl gap visibility endpoint
router.get('/coverage', async (req, res) => {
  try {
    // Per-city gap: URLs found vs scraped vs blocked
    const recentJobs = await CrawlJob.find({ type: 'city', status: { $in: ['completed', 'partial', 'failed'] } })
      .sort({ completedAt: -1 })
      .limit(50)
      .select('input.cityName status progress categoryYield completedAt')
      .lean();

    const coverage = recentJobs.map(j => ({
      city: j.input?.cityName,
      status: j.status,
      discovered: j.progress?.total || 0,
      scraped: j.progress?.scraped || 0,
      failed: j.progress?.failed || 0,
      blocked: j.progress?.blockedCount || 0,
      skipped: j.progress?.skipped || 0,
      gap: (j.progress?.total || 0) - (j.progress?.scraped || 0) - (j.progress?.skipped || 0),
      zeroYieldCategories: (j.categoryYield || []).filter(c => c.urlsFound === 0).map(c => c.category),
      completedAt: j.completedAt,
    }));

    ok(res, { coverage });
  } catch (e) { err(res, e.message); }
});

// GET /api/crawl/categories
router.get('/categories', (_, res) => ok(res, { categories: FITNESS_CATEGORIES }));

// DELETE /api/crawl/jobs/:jobId
router.delete('/jobs/:jobId', async (req, res) => {
  try {
    await CrawlJob.findOneAndDelete({ jobId: req.params.jobId });
    ok(res, { message: 'Job deleted' });
  } catch (e) { err(res, e.message); }
});

// POST /api/crawl/jobs/bulk-delete
router.post('/jobs/bulk-delete', async (req, res) => {
  try {
    const { jobIds } = req.body;
    if (!jobIds || !Array.isArray(jobIds)) return err(res, 'jobIds array is required');
    await CrawlJob.deleteMany({ jobId: { $in: jobIds } });
    ok(res, { message: `${jobIds.length} jobs deleted` });
  } catch (e) { err(res, e.message); }
});

// POST /api/crawl/jobs/clear-history
router.post('/jobs/clear-history', async (req, res) => {
  try {
    const result = await CrawlJob.deleteMany({ status: { $nin: ['running', 'queued'] } });
    ok(res, { message: `Cleared ${result.deletedCount} historical jobs` });
  } catch (e) { err(res, e.message); }
});

// ── Phase 3: Smart entry points ───────────────────────────────────────────────

// POST /api/crawl/by-name
// Scrape a specific fitness space by name, fanning out to all sources.
// Body: { name, location?, categories?, deepCrossRef? }
router.post('/by-name',
  body('name').notEmpty().trim().isLength({ min: 2, max: 200 }),
  body('location').optional().trim(),
  body('categories').optional().isArray(),
  body('deepCrossRef').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { name, location = null, deepCrossRef = true } = req.body;
    const categories = Array.isArray(req.body.categories) ? req.body.categories : [];
    try {
      const jobId = uuidv4();
      await CrawlJob.create({
        jobId,
        type: 'space_name',
        input: { name, location, categories, deepCrossRef },
        status: 'queued',
      });
      await addSpaceNameJob(jobId, name, location, categories, deepCrossRef);
      bus.publish('job:queued', { jobId, type: 'space_name', name, location });
      ok(res, { message: `Multi-source name search queued for "${name}"`, jobId, trackAt: `/api/crawl/status/${jobId}` }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

// POST /api/crawl/by-url
// Scrape a fitness space from a direct URL (Google Maps, JustDial, Yelp, website, etc.)
// Body: { url, deepCrossRef? }
router.post('/by-url',
  body('url').notEmpty().isURL({ require_protocol: true }),
  body('deepCrossRef').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { url, deepCrossRef = true } = req.body;
    try {
      const jobId = uuidv4();
      await CrawlJob.create({
        jobId,
        type: 'space_url',
        input: { url, deepCrossRef },
        status: 'queued',
      });
      await addSpaceUrlJob(jobId, url, deepCrossRef);
      bus.publish('job:queued', { jobId, type: 'space_url', url });
      ok(res, { message: `URL scrape queued for ${url.slice(0, 80)}`, jobId, trackAt: `/api/crawl/status/${jobId}` }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

// POST /api/crawl/by-area
// Enhanced area crawl — fans out to all sources for a given area/city.
// Body: { area, categories? }
router.post('/by-area',
  body('area').notEmpty().trim().isLength({ min: 2, max: 200 }),
  body('categories').optional().isArray(),
  body('force').optional().isBoolean(),
  body('skipRecentDays').optional().isInt({ min: 0 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const { area, force = false } = req.body;
    const categories = Array.isArray(req.body.categories) ? req.body.categories : FITNESS_CATEGORIES;
    const skipRecentDays = req.body.skipRecentDays !== undefined ? Number(req.body.skipRecentDays) : undefined;
    try {
      if (!force) {
        const active = await hasActiveJob(area);
        if (active) {
          return ok(res, {
            message: `"${area}" already has an active job (${active.status}). Use force:true to override.`,
            existingJobId: active.jobId,
            trackAt: `/api/crawl/status/${active.jobId}`,
          }, 409);
        }
      }
      const jobId = uuidv4();
      await CrawlJob.create({
        jobId,
        type: 'city',
        input: { cityName: area, categories, skipRecentDays, multiSource: true },
        status: 'queued',
      });
      await addCityJob(jobId, area, categories, skipRecentDays);
      bus.publish('job:queued', { jobId, type: 'city', cityName: area, multiSource: true });
      ok(res, { message: `Multi-source area crawl queued for "${area}"`, jobId, trackAt: `/api/crawl/status/${jobId}` }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

module.exports = router;
