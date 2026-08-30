'use strict';
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { addChainJob, getChainQueueStats } = require('../queue/queues');
const CrawlJob  = require('../db/crawlJobModel');
const GymChain  = require('../db/gymChainModel');
const Gym       = require('../db/spaceModel');
const { tagExistingGyms, tagChain } = require('../services/chainTagger');
const logger    = require('../utils/logger');
const { ok, err, validate } = require('../utils/apiUtils');
const bus       = require('../services/eventBus');

// ── Dedup helper ─────────────────────────────────────────────────────────────

async function hasActiveChainJob(chainSlug) {
  return CrawlJob.findOne({
    'input.chainSlug': chainSlug,
    status: { $in: ['queued', 'running'] },
  }).lean();
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHAIN CRUD ROUTES (mounted at /api/chains)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * tags:
 *   name: Chains
 *   description: Gym chain management and chain crawling
 */

/**
 * @swagger
 * /api/chains:
 *   get:
 *     summary: List all registered gym chains
 *     tags: [Chains]
 *     responses:
 *       200:
 *         description: List of chains with stats
 */
router.get('/', async (req, res) => {
  try {
    const chains = await GymChain.find().sort({ name: 1 }).lean();
    ok(res, { total: chains.length, chains });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/chains:
 *   post:
 *     summary: Register a new gym chain
 *     tags: [Chains]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Equinox"
 *               slug:
 *                 type: string
 *                 example: "equinox"
 *               aliases:
 *                 type: array
 *                 items:
 *                   type: string
 *               website:
 *                 type: string
 *               headquarters:
 *                 type: string
 *               crawlFrequency:
 *                 type: string
 *                 enum: [weekly, biweekly, monthly, quarterly]
 */
router.post('/',
  body('name').notEmpty().trim(),
  body('slug').notEmpty().trim(),
  body('aliases').optional().isArray(),
  body('website').optional().isString(),
  body('headquarters').optional().isString(),
  body('crawlFrequency').optional().isIn(['weekly', 'biweekly', 'monthly', 'quarterly']),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const existing = await GymChain.findOne({ slug: req.body.slug }).lean();
      if (existing) {
        return ok(res, { message: 'Chain already exists', chain: existing }, 409);
      }

      const chain = await GymChain.create(req.body);
      logger.info(`[Chains API] Created chain: ${chain.name} (${chain.slug})`);
      ok(res, { message: 'Chain created', chain }, 201);
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/chains/{slug}:
 *   get:
 *     summary: Get chain details and stats
 *     tags: [Chains]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:slug', async (req, res) => {
  try {
    const chain = await GymChain.findOne({ slug: req.params.slug }).lean();
    if (!chain) return err(res, 'Chain not found', 404);

    const gymCount = await Gym.countDocuments({ chainSlug: chain.slug, isChainMember: true });
    const countries = await Gym.distinct('addressParts.country', { chainSlug: chain.slug });

    ok(res, {
      chain,
      stats: {
        totalGyms: gymCount,
        countries: countries.filter(Boolean),
        countryCount: countries.filter(Boolean).length,
      },
    });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/chains/{slug}/gyms:
 *   get:
 *     summary: List all gyms belonging to a chain
 *     tags: [Chains]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: country
 *         schema:
 *           type: string
 */
router.get('/:slug/gyms',
  query('limit').optional().isInt({ min: 1, max: 200 }),
  query('page').optional().isInt({ min: 1 }),
  query('country').optional().isString(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { limit = 50, page = 1, country } = req.query;

    try {
      const chain = await GymChain.findOne({ slug: req.params.slug }).lean();
      if (!chain) return err(res, 'Chain not found', 404);

      const filter = { chainSlug: chain.slug, isChainMember: true };
      if (country) {
        filter['addressParts.country'] = { $regex: new RegExp(country, 'i') };
      }

      const [gyms, total] = await Promise.all([
        Gym.find(filter)
          .select('name address lat lng rating totalReviews contact areaName addressParts coverPhoto')
          .sort({ name: 1 })
          .limit(+limit)
          .skip((+page - 1) * +limit)
          .lean(),
        Gym.countDocuments(filter),
      ]);

      ok(res, { chainSlug: chain.slug, chainName: chain.name, total, page: +page, limit: +limit, gyms });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/chains/{slug}:
 *   put:
 *     summary: Update a chain
 *     tags: [Chains]
 */
router.put('/:slug',
  body('name').optional().isString(),
  body('aliases').optional().isArray(),
  body('website').optional().isString(),
  body('crawlFrequency').optional().isIn(['weekly', 'biweekly', 'monthly', 'quarterly']),
  body('isActive').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const chain = await GymChain.findOneAndUpdate(
        { slug: req.params.slug },
        { $set: req.body },
        { new: true }
      );
      if (!chain) return err(res, 'Chain not found', 404);
      ok(res, { message: 'Chain updated', chain });
    } catch (e) { err(res, e.message); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  CHAIN CRAWL ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/chains/crawl/start:
 *   post:
 *     summary: Queue a chain crawl job
 *     tags: [Chains]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chainSlug]
 *             properties:
 *               chainSlug:
 *                 type: string
 *                 example: "anytime-fitness"
 *               countries:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["IN", "US"]
 *               force:
 *                 type: boolean
 */
router.post('/crawl/start',
  body('chainSlug').notEmpty().trim(),
  body('countries').optional().isArray(),
  body('force').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { chainSlug, countries = [], force = false } = req.body;

    try {
      // Validate chain exists
      const chain = await GymChain.findOne({ slug: chainSlug }).lean();
      if (!chain) return err(res, `Chain not found: ${chainSlug}`, 404);

      // Dedup guard
      if (!force) {
        const active = await hasActiveChainJob(chainSlug);
        if (active) {
          return ok(res, {
            message: `Chain "${chain.name}" already has an active job (${active.status}). Use force:true to override.`,
            existingJobId: active.jobId,
            trackAt: `/api/crawl/status/${active.jobId}`,
          }, 409);
        }
      }

      const jobId = uuidv4();
      await CrawlJob.create({
        jobId,
        type: 'chain',
        input: { chainSlug, chainName: chain.name, countries },
        status: 'queued',
      });
      await addChainJob(jobId, chainSlug, chain.name, countries);

      bus.publish('job:queued', { jobId, type: 'chain', chainSlug, chainName: chain.name, countries });

      ok(res, {
        message: `Chain crawl queued for "${chain.name}"`,
        jobId,
        chainSlug,
        countries: countries.length ? countries : 'all',
        trackAt: `/api/crawl/status/${jobId}`,
      }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/chains/crawl/batch:
 *   post:
 *     summary: Queue crawls for multiple chains
 *     tags: [Chains]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chains]
 *             properties:
 *               chains:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     slug:
 *                       type: string
 *                     countries:
 *                       type: array
 *                       items:
 *                         type: string
 *               force:
 *                 type: boolean
 */
router.post('/crawl/batch',
  body('chains').isArray({ min: 1 }),
  body('chains.*.slug').isString().notEmpty(),
  body('force').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { chains, force = false } = req.body;

    try {
      const jobs = [];
      const skipped = [];

      for (const entry of chains) {
        const { slug, countries = [] } = entry;
        const chain = await GymChain.findOne({ slug }).lean();
        if (!chain) {
          skipped.push({ slug, reason: 'Chain not found' });
          continue;
        }

        if (!force) {
          const active = await hasActiveChainJob(slug);
          if (active) {
            skipped.push({ slug, chainName: chain.name, existingJobId: active.jobId, reason: 'Already active' });
            continue;
          }
        }

        const jobId = uuidv4();
        await CrawlJob.create({
          jobId,
          type: 'chain',
          input: { chainSlug: slug, chainName: chain.name, countries },
          status: 'queued',
        });
        await addChainJob(jobId, slug, chain.name, countries);
        jobs.push({ chainSlug: slug, chainName: chain.name, jobId, countries });
      }

      ok(res, {
        message: `${jobs.length} chain(s) queued, ${skipped.length} skipped`,
        jobs,
        skipped,
      }, 202);
    } catch (e) { logger.error(e.message); err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/chains/crawl/queue-stats:
 *   get:
 *     summary: Get chain crawl queue statistics
 *     tags: [Chains]
 */
router.get('/crawl/queue-stats', async (req, res) => {
  try {
    ok(res, { queue: await getChainQueueStats() });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CHAIN TAGGING ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/chains/tag-existing:
 *   post:
 *     summary: Retroactively tag existing gyms with chain identity
 *     tags: [Chains]
 *     description: Scans all gyms in the DB and tags those matching known chain name patterns
 */
router.post('/tag-existing', async (req, res) => {
  try {
    const result = await tagExistingGyms();
    ok(res, {
      message: `Tagged ${result.totalTagged} gyms across all chains`,
      ...result,
    });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/chains/{slug}/tag:
 *   post:
 *     summary: Tag existing gyms for a specific chain
 *     tags: [Chains]
 */
router.post('/:slug/tag', async (req, res) => {
  try {
    const result = await tagChain(req.params.slug);
    ok(res, { message: `Tagged ${result.gymsTagged} gyms for ${result.chainName}`, ...result });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/chains/{slug}:
 *   delete:
 *     summary: Delete a chain (does not remove gyms)
 *     tags: [Chains]
 */
router.delete('/:slug', async (req, res) => {
  try {
    const result = await GymChain.findOneAndDelete({ slug: req.params.slug });
    if (!result) return err(res, 'Chain not found', 404);
    ok(res, { message: `Chain "${result.name}" deleted. Gyms are NOT removed.` });
  } catch (e) { err(res, e.message); }
});

module.exports = router;
