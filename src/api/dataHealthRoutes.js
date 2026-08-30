'use strict';
const express = require('express');
const { query, validationResult } = require('express-validator');
const router  = express.Router();
const Gym     = require('../db/spaceModel');
const GymChangeLog = require('../db/gymChangeLogModel');
const { Review }   = require('../db/reviewModel');
const { ok, err, validate } = require('../utils/apiUtils');

/**
 * @swagger
 * tags:
 *   name: DataHealth
 *   description: Data completeness, quality, and change tracking intelligence
 */

/* ═══════════════════════════════════════════════════════════
   DATA HEALTH — Aggregate metrics about data quality
   ═══════════════════════════════════════════════════════════ */

/**
 * GET /api/data-health/overview
 * Returns comprehensive data health metrics in a single call
 */
router.get('/overview', async (req, res) => {
  try {
    const now = Date.now();
    const DAY_MS = 86_400_000;

    const [
      totalGyms,
      missingFields,
      stalenessBuckets,
      qualityDistribution,
      sentimentDistribution,
      ratingDistribution,
      closedGyms,
      enrichmentStatus,
      reviewCoverage,
    ] = await Promise.all([
      // Total count
      Gym.countDocuments(),

      // Missing fields aggregation
      Gym.aggregate([
        {
          $addFields: {
            effectiveCompleteness: { $ifNull: ['$crawl.dataCompleteness', '$crawlMeta.dataCompleteness'] },
          },
        },
        {
        $group: {
          _id: null,
          total: { $sum: 1 },
          missingPhone:       { $sum: { $cond: [{ $or: [{ $eq: ['$contact.phone', null] }, { $eq: ['$contact.phone', ''] }, { $not: '$contact.phone' }] }, 1, 0] } },
          missingWebsite:     { $sum: { $cond: [{ $or: [{ $eq: ['$contact.website', null] }, { $eq: ['$contact.website', ''] }, { $not: '$contact.website' }] }, 1, 0] } },
          missingHours:       { $sum: { $cond: [{ $or: [{ $eq: [{ $size: { $ifNull: ['$openingHours', []] } }, 0] }, { $not: '$openingHours' }] }, 1, 0] } },
          missingPhotos:      { $sum: { $cond: [{ $lte: [{ $ifNull: ['$totalPhotos', 0] }, 0] }, 1, 0] } },
          missingDescription: { $sum: { $cond: [{ $or: [{ $eq: ['$description', null] }, { $eq: ['$description', ''] }, { $not: '$description' }] }, 1, 0] } },
          missingRating:      { $sum: { $cond: [{ $or: [{ $eq: ['$rating', null] }, { $eq: ['$rating', 0] }, { $not: '$rating' }] }, 1, 0] } },
          missingAddress:     { $sum: { $cond: [{ $or: [{ $eq: ['$address', null] }, { $eq: ['$address', ''] }, { $not: '$address' }] }, 1, 0] } },
          missingReviews:     { $sum: { $cond: [{ $lte: [{ $ifNull: ['$totalReviews', 0] }, 0] }, 1, 0] } },
          missingLocation:    { $sum: { $cond: [{ $or: [{ $not: '$lat' }, { $not: '$lng' }] }, 1, 0] } },
          avgCompleteness:    { $avg: { $ifNull: ['$effectiveCompleteness', 0] } },
        },
      }]),

      // Staleness buckets
      Gym.aggregate([{
        $group: {
          _id: null,
          fresh:     { $sum: { $cond: [{ $gte: ['$updatedAt', new Date(now - 7 * DAY_MS)] }, 1, 0] } },
          recent:    { $sum: { $cond: [{ $and: [{ $lt: ['$updatedAt', new Date(now - 7 * DAY_MS)] }, { $gte: ['$updatedAt', new Date(now - 30 * DAY_MS)] }] }, 1, 0] } },
          aging:     { $sum: { $cond: [{ $and: [{ $lt: ['$updatedAt', new Date(now - 30 * DAY_MS)] }, { $gte: ['$updatedAt', new Date(now - 90 * DAY_MS)] }] }, 1, 0] } },
          stale:     { $sum: { $cond: [{ $lt: ['$updatedAt', new Date(now - 90 * DAY_MS)] }, 1, 0] } },
        },
      }]),

      // Quality score distribution (5 buckets) — using $group for robustness
      Gym.aggregate([{
        $group: {
          _id: null,
          b0:  { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$qualityScore', 0] }, 0] },  { $lt: [{ $ifNull: ['$qualityScore', 0] }, 20] }] }, 1, 0] } },
          b20: { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$qualityScore', 0] }, 20] }, { $lt: [{ $ifNull: ['$qualityScore', 0] }, 40] }] }, 1, 0] } },
          b40: { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$qualityScore', 0] }, 40] }, { $lt: [{ $ifNull: ['$qualityScore', 0] }, 60] }] }, 1, 0] } },
          b60: { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$qualityScore', 0] }, 60] }, { $lt: [{ $ifNull: ['$qualityScore', 0] }, 80] }] }, 1, 0] } },
          b80: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$qualityScore', 0] }, 80] }, 1, 0] } },
        },
      }]),

      // Sentiment distribution (5 buckets)
      Gym.aggregate([{
        $group: {
          _id: null,
          veryNeg:  { $sum: { $cond: [{ $lt:  [{ $ifNull: ['$sentimentScore', 0] }, -0.5] }, 1, 0] } },
          neg:      { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$sentimentScore', 0] }, -0.5] }, { $lt: [{ $ifNull: ['$sentimentScore', 0] }, -0.1] }] }, 1, 0] } },
          neutral:  { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$sentimentScore', 0] }, -0.1] }, { $lt: [{ $ifNull: ['$sentimentScore', 0] }, 0.1] }] }, 1, 0] } },
          pos:      { $sum: { $cond: [{ $and: [{ $gte: [{ $ifNull: ['$sentimentScore', 0] }, 0.1] },  { $lt: [{ $ifNull: ['$sentimentScore', 0] }, 0.5] }] }, 1, 0] } },
          veryPos:  { $sum: { $cond: [{ $gte: [{ $ifNull: ['$sentimentScore', 0] }, 0.5] }, 1, 0] } },
        },
      }]),

      // Rating distribution (6 buckets)
      Gym.aggregate([{
        $match: { rating: { $gt: 0 } },
      }, {
        $group: {
          _id: null,
          r01: { $sum: { $cond: [{ $lt: ['$rating', 1] }, 1, 0] } },
          r12: { $sum: { $cond: [{ $and: [{ $gte: ['$rating', 1] }, { $lt: ['$rating', 2] }] }, 1, 0] } },
          r23: { $sum: { $cond: [{ $and: [{ $gte: ['$rating', 2] }, { $lt: ['$rating', 3] }] }, 1, 0] } },
          r34: { $sum: { $cond: [{ $and: [{ $gte: ['$rating', 3] }, { $lt: ['$rating', 4] }] }, 1, 0] } },
          r445:{ $sum: { $cond: [{ $and: [{ $gte: ['$rating', 4] }, { $lt: ['$rating', 4.5] }] }, 1, 0] } },
          r45: { $sum: { $cond: [{ $gte: ['$rating', 4.5] }, 1, 0] } },
        },
      }]),

      // Closed gyms stats
      Gym.aggregate([{
        $group: {
          _id: null,
          permanentlyClosed: { $sum: { $cond: ['$permanentlyClosed', 1, 0] } },
          temporarilyClosed: { $sum: { $cond: ['$temporarilyClosed', 1, 0] } },
        },
      }]),

      // Enrichment status breakdown
      Gym.aggregate([{
        $group: {
          _id: { $ifNull: ['$enrichmentMeta.status', 'never'] },
          count: { $sum: 1 },
        },
      }]),

      // Review coverage
      Review.aggregate([
        { $group: { _id: '$gymId' } },
        { $count: 'gymsWithReviews' },
      ]),
    ]);

    // Map quality buckets to friendly labels
    const qd = qualityDistribution[0] || {};
    const qualityBuckets = [
      { label: '0–20', count: qd.b0 || 0 },
      { label: '20–40', count: qd.b20 || 0 },
      { label: '40–60', count: qd.b40 || 0 },
      { label: '60–80', count: qd.b60 || 0 },
      { label: '80–100', count: qd.b80 || 0 },
    ];

    // Map sentiment buckets
    const sd = sentimentDistribution[0] || {};
    const sentimentBuckets = [
      { label: 'Very Negative', count: sd.veryNeg || 0 },
      { label: 'Negative', count: sd.neg || 0 },
      { label: 'Neutral', count: sd.neutral || 0 },
      { label: 'Positive', count: sd.pos || 0 },
      { label: 'Very Positive', count: sd.veryPos || 0 },
    ];

    const fields = missingFields[0] || {};
    const total = fields.total || totalGyms || 1;
    
    const rd = ratingDistribution[0] || {};

    ok(res, {
      health: {
        totalGyms,
        avgCompleteness: Math.round(fields.avgCompleteness || 0),
        missingFields: {
          phone:       { count: fields.missingPhone || 0,       pct: Math.round(((fields.missingPhone || 0) / total) * 100) },
          website:     { count: fields.missingWebsite || 0,     pct: Math.round(((fields.missingWebsite || 0) / total) * 100) },
          hours:       { count: fields.missingHours || 0,       pct: Math.round(((fields.missingHours || 0) / total) * 100) },
          photos:      { count: fields.missingPhotos || 0,      pct: Math.round(((fields.missingPhotos || 0) / total) * 100) },
          description: { count: fields.missingDescription || 0, pct: Math.round(((fields.missingDescription || 0) / total) * 100) },
          rating:      { count: fields.missingRating || 0,      pct: Math.round(((fields.missingRating || 0) / total) * 100) },
          address:     { count: fields.missingAddress || 0,     pct: Math.round(((fields.missingAddress || 0) / total) * 100) },
          reviews:     { count: fields.missingReviews || 0,     pct: Math.round(((fields.missingReviews || 0) / total) * 100) },
          location:    { count: fields.missingLocation || 0,    pct: Math.round(((fields.missingLocation || 0) / total) * 100) },
        },
        staleness: {
          fresh:  stalenessBuckets[0]?.fresh  || 0,
          recent: stalenessBuckets[0]?.recent || 0,
          aging:  stalenessBuckets[0]?.aging  || 0,
          stale:  stalenessBuckets[0]?.stale  || 0,
        },
        qualityDistribution: qualityBuckets,
        sentimentDistribution: sentimentBuckets,
        ratingDistribution: [
          { range: '0–1', count: rd.r01 || 0 },
          { range: '1–2', count: rd.r12 || 0 },
          { range: '2–3', count: rd.r23 || 0 },
          { range: '3–4', count: rd.r34 || 0 },
          { range: '4–4.5', count: rd.r445 || 0 },
          { range: '4.5–5', count: rd.r45 || 0 },
        ],
        closedGyms: {
          permanently: closedGyms[0]?.permanentlyClosed || 0,
          temporarily: closedGyms[0]?.temporarilyClosed || 0,
        },
        enrichmentStatus: enrichmentStatus.reduce((acc, s) => {
          acc[s._id] = s.count;
          return acc;
        }, {}),
        gymsWithReviews: reviewCoverage[0]?.gymsWithReviews || 0,
      },
    });
  } catch (e) { err(res, e.message); }
});


/**
 * GET /api/data-health/worst
 * Returns the lowest-quality gyms for enrichment targeting
 */
router.get('/worst',
  query('limit').optional().isInt({ min: 1, max: 50 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const limit = parseInt(req.query.limit || '20', 10);
    try {
      const gyms = await Gym.find({
        permanentlyClosed: { $ne: true },
        googleMapsUrl: { $exists: true, $ne: null },
      })
        .sort({ qualityScore: 1 })
        .select('_id name areaName rating totalReviews qualityScore sentimentScore updatedAt enrichmentMeta.status contact.phone contact.website totalPhotos category coverPhoto')
        .limit(limit)
        .lean();

      // Calculate what each gym is missing
      const enriched = gyms.map(g => {
        const missing = [];
        if (!g.contact?.phone) missing.push('phone');
        if (!g.contact?.website) missing.push('website');
        if (!g.totalPhotos || g.totalPhotos === 0) missing.push('photos');
        if (!g.totalReviews || g.totalReviews === 0) missing.push('reviews');
        if (!g.rating) missing.push('rating');
        return { ...g, missing };
      });

      ok(res, { gyms: enriched, count: enriched.length });
    } catch (e) { err(res, e.message); }
  }
);


/**
 * GET /api/data-health/stale
 * Returns gyms not updated in a given number of days
 */
router.get('/stale',
  query('days').optional().isInt({ min: 1, max: 365 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const days = parseInt(req.query.days || '30', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    try {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const gyms = await Gym.find({
        updatedAt: { $lt: cutoff },
        permanentlyClosed: { $ne: true },
      })
        .sort({ updatedAt: 1 })
        .select('_id name areaName rating qualityScore updatedAt category coverPhoto')
        .limit(limit)
        .lean();

      const total = await Gym.countDocuments({
        updatedAt: { $lt: cutoff },
        permanentlyClosed: { $ne: true },
      });

      ok(res, { gyms, total, days, cutoff });
    } catch (e) { err(res, e.message); }
  }
);


/* ═══════════════════════════════════════════════════════════
   CHANGE LOG — Gym change tracking feed
   ═══════════════════════════════════════════════════════════ */

/**
 * GET /api/data-health/changes
 * Paginated change feed with optional field filter
 */
router.get('/changes',
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('skip').optional().isInt({ min: 0 }),
  query('field').optional().trim(),
  query('days').optional().isInt({ min: 1, max: 365 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const limit = parseInt(req.query.limit || '30', 10);
    const skip  = parseInt(req.query.skip  || '0', 10);
    const field = req.query.field;
    const days  = parseInt(req.query.days || '30', 10);

    const filter = {
      changedAt: { $gte: new Date(Date.now() - days * 86_400_000) },
    };
    if (field) filter.field = field;

    try {
      const [changes, total, fieldBreakdown] = await Promise.all([
        GymChangeLog.find(filter)
          .sort({ changedAt: -1 })
          .limit(limit)
          .skip(skip)
          .populate('gymId', 'name areaName coverPhoto')
          .lean(),
        GymChangeLog.countDocuments(filter),
        GymChangeLog.aggregate([
          { $match: { changedAt: { $gte: new Date(Date.now() - days * 86_400_000) } } },
          { $group: { _id: '$field', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 15 },
        ]),
      ]);

      ok(res, {
        changes,
        total,
        limit,
        skip,
        fieldBreakdown: fieldBreakdown.map(f => ({ field: f._id, count: f.count })),
      });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * GET /api/data-health/changes/significant
 * Returns only significant changes — rating drops, closures, reopenings
 */
router.get('/changes/significant',
  query('days').optional().isInt({ min: 1, max: 365 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const days = parseInt(req.query.days || '30', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const since = new Date(Date.now() - days * 86_400_000);

    try {
      const significantFields = ['rating', 'permanentlyClosed', 'temporarilyClosed', 'totalReviews', 'contact.phone', 'contact.website'];

      const changes = await GymChangeLog.find({
        changedAt: { $gte: since },
        field: { $in: significantFields },
      })
        .sort({ changedAt: -1 })
        .limit(limit)
        .populate('gymId', 'name areaName rating coverPhoto')
        .lean();

      // Categorize changes
      const categorized = changes.map(c => {
        let severity = 'info';
        let label = 'Updated';

        if (c.field === 'rating' && c.newValue < c.oldValue) {
          severity = 'warning';
          label = `Rating dropped ${c.oldValue} → ${c.newValue}`;
        } else if (c.field === 'rating' && c.newValue > c.oldValue) {
          severity = 'success';
          label = `Rating improved ${c.oldValue} → ${c.newValue}`;
        } else if (c.field === 'permanentlyClosed' && c.newValue === true) {
          severity = 'danger';
          label = 'Permanently closed';
        } else if (c.field === 'permanentlyClosed' && c.newValue === false) {
          severity = 'success';
          label = 'Reopened';
        } else if (c.field === 'temporarilyClosed' && c.newValue === true) {
          severity = 'warning';
          label = 'Temporarily closed';
        } else if (c.field === 'temporarilyClosed' && c.newValue === false) {
          severity = 'success';
          label = 'Reopened (temp)';
        } else if (c.field === 'totalReviews') {
          severity = 'info';
          label = `Reviews ${c.oldValue || 0} → ${c.newValue}`;
        } else if (c.field.startsWith('contact.')) {
          severity = 'info';
          label = `${c.field.split('.')[1]} updated`;
        }

        return { ...c, severity, label };
      });

      ok(res, { changes: categorized, count: categorized.length, days });
    } catch (e) { err(res, e.message); }
  }
);


/**
 * GET /api/data-health/changes/daily
 * Aggregated daily change counts for charts
 */
router.get('/changes/daily',
  query('days').optional().isInt({ min: 1, max: 90 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const days = parseInt(req.query.days || '14', 10);
    const since = new Date(Date.now() - days * 86_400_000);

    try {
      const dailyChanges = await GymChangeLog.aggregate([
        { $match: { changedAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$changedAt' } },
            total: { $sum: 1 },
            uniqueGyms: { $addToSet: '$gymId' },
          },
        },
        {
          $project: {
            _id: 1,
            total: 1,
            gymsAffected: { $size: '$uniqueGyms' },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      ok(res, { dailyChanges, days });
    } catch (e) { err(res, e.message); }
  }
);

module.exports = router;
