'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

const Space = require('../db/spaceModel');
const EnrichmentLog = require('../db/enrichmentLogModel');
const logger = require('../utils/logger');
const { ok, err, validate } = require('../utils/apiUtils');
const {
  pauseEnrichment,
  resumeEnrichment,
  isPaused,
  pushPrioritySpace,
  getEnrichmentStats,
  getPriorityQueue,
} = require('../services/enrichmentService');

/**
 * @swagger
 * tags:
 *   name: Enrichment
 *   description: Continuous space enrichment queue management
 */

/**
 * GET /api/enrichment/status — current enrichment engine status
 */
router.get('/status', async (req, res) => {
  try {
    const stats = await getEnrichmentStats();

    // Also get count of spaces needing enrichment (oldest-updated first)
    const totalSpaces = await Space.countDocuments({
      permanentlyClosed: { $ne: true },
      googleMapsUrl: { $exists: true, $ne: null },
    });

    // Spaces not updated in last 7 days
    const staleCount = await Space.countDocuments({
      permanentlyClosed: { $ne: true },
      googleMapsUrl: { $exists: true, $ne: null },
      updatedAt: { $lt: new Date(Date.now() - 7 * 86_400_000) },
    });

    // Next space in queue (oldest updatedAt)
    const nextInQueue = await Space.findOne({
      permanentlyClosed: { $ne: true },
      googleMapsUrl: { $exists: true, $ne: null },
    })
      .sort({ updatedAt: 1 })
      .select('_id name areaName updatedAt')
      .lean();

    ok(res, {
      enrichment: {
        ...stats,
        totalEligibleSpaces: totalSpaces,
        staleSpaces: staleCount,
        nextInQueue: nextInQueue ? {
          id: nextInQueue._id,
          name: nextInQueue.name,
          area: nextInQueue.areaName,
          lastUpdated: nextInQueue.updatedAt,
        } : null,
      },
    });
  } catch (e) { err(res, e.message); }
});

/**
 * POST /api/enrichment/pause — pause the enrichment loop
 */
router.post('/pause', async (req, res) => {
  try {
    await pauseEnrichment();
    logger.info('⏸️  Enrichment paused via API');
    ok(res, { message: 'Enrichment paused', paused: true });
  } catch (e) { err(res, e.message); }
});

/**
 * POST /api/enrichment/resume — resume the enrichment loop
 */
router.post('/resume', async (req, res) => {
  try {
    await resumeEnrichment();
    logger.info('▶️  Enrichment resumed via API');
    ok(res, { message: 'Enrichment resumed', paused: false });
  } catch (e) { err(res, e.message); }
});

/**
 * POST /api/enrichment/toggle — toggle pause/resume
 */
router.post('/toggle', async (req, res) => {
  try {
    const paused = await isPaused();
    if (paused) {
      await resumeEnrichment();
      ok(res, { message: 'Enrichment resumed', paused: false });
    } else {
      await pauseEnrichment();
      ok(res, { message: 'Enrichment paused', paused: true });
    }
  } catch (e) { err(res, e.message); }
});

/**
 * POST /api/enrichment/priority — push a specific space to top of enrichment queue
 */
router.post('/priority',
  body('spaceId').notEmpty().matches(/^(OPG-[A-Z]+-[A-Z0-9]+|[a-fA-F0-9]{24})$/),
  body('sections').optional().isArray(),
  body('sections.*').optional().isIn(['all', 'reviews', 'photos', 'contact', 'hours', 'amenities', 'deep']),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { spaceId, sections } = req.body;
      const isMongoId = /^[a-fA-F0-9]{24}$/.test(spaceId);
      const space = isMongoId ? await Space.findById(spaceId).select('_id name areaName googleMapsUrl').lean() : await Space.findOne({ opgId: spaceId }).select('_id name areaName googleMapsUrl').lean();
      if (!space) return err(res, 'Space not found', 404);
      if (!space.googleMapsUrl) return err(res, 'Space has no Google Maps URL — cannot enrich', 400);

      await pushPrioritySpace(space._id.toString(), space.name, sections);

      const sectionLabel = (!sections || sections.includes('all')) ? 'full' : sections.join(', ');
      ok(res, {
        message: `"${space.name}" pushed to enrichment priority queue [${sectionLabel}] — will be enriched next`,
        spaceId,
        spaceName: space.name,
        sections: sections || ['all'],
      });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * POST /api/enrichment/priority/batch — push multiple spaces to priority queue
 */
router.post('/priority/batch',
  body('spaceIds').isArray({ min: 1, max: 50 }),
  body('spaceIds.*').matches(/^(OPG-[A-Z]+-[A-Z0-9]+|[a-fA-F0-9]{24})$/),
  body('sections').optional().isArray(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { spaceIds, sections } = req.body;
      const spaces = await Space.find({
        $or: [{ _id: { $in: spaceIds.filter(id => /^[a-fA-F0-9]{24}$/.test(id)) } }, { opgId: { $in: spaceIds.filter(id => /^OPG-/.test(id)) } }],
        googleMapsUrl: { $exists: true, $ne: null },
      }).select('_id name').lean();

      for (const space of spaces) {
        await pushPrioritySpace(space._id.toString(), space.name, sections);
      }

      ok(res, {
        message: `${spaces.length} spaces pushed to enrichment priority queue`,
        pushed: spaces.map(g => ({ id: g._id, name: g.name })),
        skipped: spaceIds.length - spaces.length,
        sections: sections || ['all'],
      });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * GET /api/enrichment/queue — view priority queue contents
 */
router.get('/queue', async (req, res) => {
  try {
    const queue = await getPriorityQueue();
    ok(res, { queue, length: queue.length });
  } catch (e) { err(res, e.message); }
});

/**
 * GET /api/enrichment/candidates — preview next N spaces in the enrichment queue
 */
router.get('/candidates', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const candidates = await Space.find({
      permanentlyClosed: { $ne: true },
      googleMapsUrl: { $exists: true, $ne: null },
    })
      .sort({ updatedAt: 1 })
      .select('_id name areaName category rating totalReviews updatedAt')
      .limit(limit)
      .lean();

    ok(res, {
      candidates,
      count: candidates.length,
      oldestUpdate: candidates[0]?.updatedAt || null,
    });
  } catch (e) { err(res, e.message); }
});

/**
 * GET /api/enrichment/logs — historical enrichment attempts
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const skip = parseInt(req.query.skip || '0', 10);
    const status = req.query.status;

    const query = {};
    if (status) query.status = status;

    const [logs, total] = await Promise.all([
      EnrichmentLog.find(query)
        .sort({ startedAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      EnrichmentLog.countDocuments(query)
    ]);

    ok(res, { logs, total, limit, skip });
  } catch (e) { err(res, e.message); }
});

/**
 * GET /api/enrichment/logs/:spaceId — enrichment history for a specific space
 */
router.get('/logs/:spaceId',
  param('spaceId').matches(/^(OPG-[A-Z]+-[A-Z0-9]+|[a-fA-F0-9]{24})$/),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { spaceId } = req.params;
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

      const isMongoId = /^[a-fA-F0-9]{24}$/.test(spaceId);
      const space = isMongoId ? { _id: spaceId } : await Space.findOne({ opgId: spaceId }).select('_id').lean();
      const logs = await EnrichmentLog.find({ spaceId: space ? space._id : spaceId })
        .sort({ startedAt: -1 })
        .limit(limit)
        .lean();

      ok(res, { logs, spaceId, count: logs.length });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * GET /api/enrichment/metrics — aggregate stats for charts
 */
router.get('/metrics', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const since = new Date(Date.now() - days * 86_400_000);

    // 1. Attempts by day (Chart data)
    const dailyStats = await EnrichmentLog.aggregate([
      { $match: { startedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } },
          success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          avgDuration: { $avg: '$durationMs' },
          photos: { $sum: '$photosAdded' },
          reviews: { $sum: '$reviewsAdded' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // 2. Error summary (Top errors)
    const topErrors = await EnrichmentLog.aggregate([
      { $match: { startedAt: { $gte: since }, status: 'failed' } },
      { $group: { _id: '$error', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // 3. Field updates breakdown
    const fieldStats = await EnrichmentLog.aggregate([
      { $match: { startedAt: { $gte: since }, status: 'success' } },
      { $unwind: '$fieldsUpdated' },
      { $group: { _id: '$fieldsUpdated', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    ok(res, {
      dailyStats,
      topErrors,
      fieldStats,
      config: { days, since }
    });
  } catch (e) { err(res, e.message); }
});

module.exports = router;
