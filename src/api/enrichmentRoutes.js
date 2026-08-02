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
 *   description: Continuous gym enrichment queue management
 */

/**
 * GET /api/enrichment/status — current enrichment engine status
 */
router.get('/status', async (req, res) => {
  try {
    const stats = await getEnrichmentStats();

    // Also get count of gyms needing enrichment (oldest-updated first)
    const totalGyms = await Space.countDocuments({
      permanentlyClosed: { $ne: true },
      googleMapsUrl: { $exists: true, $ne: null },
    });

    // Gyms not updated in last 7 days
    const staleCount = await Space.countDocuments({
      permanentlyClosed: { $ne: true },
      googleMapsUrl: { $exists: true, $ne: null },
      updatedAt: { $lt: new Date(Date.now() - 7 * 86_400_000) },
    });

    // Next gym in queue (oldest updatedAt)
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
        totalEligibleGyms: totalGyms,
        staleGyms: staleCount,
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
 * POST /api/enrichment/priority — push a specific gym to top of enrichment queue
 */
router.post('/priority',
  body('gymId').notEmpty().isMongoId(),
  body('sections').optional().isArray(),
  body('sections.*').optional().isIn(['all', 'reviews', 'photos', 'contact', 'hours', 'amenities', 'deep']),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { gymId, sections } = req.body;
      const gym = await Space.findById(gymId).select('name areaName googleMapsUrl').lean();
      if (!gym) return err(res, 'Gym not found', 404);
      if (!gym.googleMapsUrl) return err(res, 'Gym has no Google Maps URL — cannot enrich', 400);

      await pushPriorityGym(gymId, gym.name, sections);

      const sectionLabel = (!sections || sections.includes('all')) ? 'full' : sections.join(', ');
      ok(res, {
        message: `"${gym.name}" pushed to enrichment priority queue [${sectionLabel}] — will be enriched next`,
        gymId,
        gymName: gym.name,
        sections: sections || ['all'],
      });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * POST /api/enrichment/priority/batch — push multiple gyms to priority queue
 */
router.post('/priority/batch',
  body('gymIds').isArray({ min: 1, max: 50 }),
  body('gymIds.*').isMongoId(),
  body('sections').optional().isArray(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { gymIds, sections } = req.body;
      const gyms = await Space.find({
        _id: { $in: gymIds },
        googleMapsUrl: { $exists: true, $ne: null },
      }).select('_id name').lean();

      for (const gym of gyms) {
        await pushPriorityGym(gym._id.toString(), gym.name, sections);
      }

      ok(res, {
        message: `${gyms.length} gyms pushed to enrichment priority queue`,
        pushed: gyms.map(g => ({ id: g._id, name: g.name })),
        skipped: gymIds.length - gyms.length,
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
 * GET /api/enrichment/candidates — preview next N gyms in the enrichment queue
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
 * GET /api/enrichment/logs/:gymId — enrichment history for a specific gym
 */
router.get('/logs/:gymId',
  param('gymId').isMongoId(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { gymId } = req.params;
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

      const logs = await EnrichmentLog.find({ gymId })
        .sort({ startedAt: -1 })
        .limit(limit)
        .lean();

      ok(res, { logs, gymId, count: logs.length });
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

/**
 * GET /api/enrichment/stats — aggregated enrichment statistics for dashboard
 */
router.get('/stats', async (req, res) => {
  try {
    const [quarantined, failed, neverEnriched, successCount] = await Promise.all([
      Space.countDocuments({ 'enrichment.status': 'quarantined', deletedAt: null }),
      Space.countDocuments({ 'enrichment.status': 'failed', deletedAt: null }),
      Space.countDocuments({ 'enrichment.status': 'never', deletedAt: null }),
      Space.countDocuments({ 'enrichment.status': 'success', deletedAt: null }),
    ]);
    const engineStatus = await getEnrichmentStats();
    ok(res, { quarantined, failed, neverEnriched, successCount, engine: engineStatus });
  } catch (e) { err(res, e.message); }
});

module.exports = router;
