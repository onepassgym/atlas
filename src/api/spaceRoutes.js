'use strict';
const express   = require('express');
const mongoose  = require('mongoose');
const { query, param } = require('express-validator');
const router    = express.Router();
const Space     = require('../db/spaceModel');
const Photo     = require('../db/photoModel');
const Location  = require('../db/locationModel');

const { ok, err, validate } = require('../utils/apiUtils');
const { isValidOpgId } = require('../utils/opgId');

// ── In-memory stats cache (TTL-based) ─────────────────────────────────────────
let _statsCache = null;
let _statsCacheAt = 0;
const STATS_CACHE_TTL = 30_000;

/* ═══════════════════════════════════════════════════════════
   SEARCH & SUGGESTIONS
   ═══════════════════════════════════════════════════════════ */

router.get('/suggestions', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return ok(res, { suggestions: [] });

  try {
    const sanitized = q.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
    const startsWith = new RegExp(`^${sanitized}`, 'i');
    const contains = new RegExp(sanitized, 'i');

    const [nameStartMatches, nameContainsMatches, areaMatches, chainMatches] = await Promise.all([
      Space.find({ name: startsWith })
           .select('name areaName city chainOpgId rating totalReviews qualityScore primaryCategorySlug coverUrl')
           .sort({ qualityScore: -1 })
           .limit(5)
           .lean(),
      Space.find({ name: contains })
           .select('name areaName city chainOpgId rating totalReviews qualityScore primaryCategorySlug coverUrl')
           .sort({ qualityScore: -1 })
           .limit(5)
           .lean(),
      Space.aggregate([
        { $match: { areaName: contains } },
        { $group: { _id: '$areaName', count: { $sum: 1 }, avgRating: { $avg: '$rating' } } },
        { $sort: { count: -1 } },
        { $limit: 4 }
      ]),
      Space.aggregate([
        { $match: { chainOpgId: { $ne: null } } },
        { $group: { _id: '$chainOpgId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 3 }
      ]),
    ]);

    const seenIds = new Set();
    const spaceSuggestions = [];
    for (const s of [...nameStartMatches, ...nameContainsMatches]) {
      if (!seenIds.has(s._id.toString())) {
        seenIds.add(s._id.toString());
        spaceSuggestions.push({
          type: 'space',
          id: s._id,
          name: s.name,
          area: s.areaName || null,
          chainOpgId: s.chainOpgId || null,
          rating: s.rating,
          reviews: s.totalReviews,
          quality: s.qualityScore,
          category: s.primaryCategorySlug,
          thumbnail: s.coverUrl || null,
        });
      }
      if (spaceSuggestions.length >= 6) break;
    }

    const suggestions = [
      ...spaceSuggestions,
      ...areaMatches.map(a => ({ type: 'area', name: a._id, count: a.count, avgRating: a.avgRating?.toFixed(1) })),
      ...chainMatches.map(c => ({ type: 'chain', opgId: c._id, count: c.count })),
    ];

    ok(res, { suggestions });
  } catch (e) { err(res, e.message); }
});

router.get('/cities', async (_, res) => {
  try {
    const cities = await Location.find({ type: 'city', isActive: true })
      .select('opgId name slug spaceCount isServiceable')
      .sort({ spaceCount: -1 })
      .limit(100)
      .lean();
    ok(res, { cities });
  } catch (e) { err(res, e.message); }
});

/* ═══════════════════════════════════════════════════════════
   LIST / FILTER
   ═══════════════════════════════════════════════════════════ */

router.get('/',
  query('city').optional().trim(),
  query('category').optional().trim(),
  query('minRating').optional().isFloat({ min: 0, max: 5 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('page').optional().isInt({ min: 1 }),
  query('sortBy').optional().isIn(['rating', 'totalReviews', 'name', 'createdAt', 'qualityScore', 'relevance']),
  async (req, res) => {
    if (validate(req, res)) return;
    const startTime = Date.now();
    const { city, category, minRating, limit = 20, page = 1, sortBy = 'qualityScore', order = 'desc', search } = req.query;
    const filter = { deletedAt: null };
    let useTextScore = false;

    if (city) filter.city = { $regex: new RegExp(city.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&'), 'i') };
    if (category) filter.primaryCategorySlug = category;
    if (minRating) filter.rating = { $gte: +minRating };

    if (search) {
      const trimmed = search.trim();
      if (trimmed.length >= 3) {
        try {
          filter.$text = { $search: trimmed };
          useTextScore = true;
        } catch (_) { useTextScore = false; }
      }
      if (!useTextScore) {
        const sanitized = trimmed.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&').replace(/\\s+/g, '');
        const fuzzyPattern = sanitized.split('').join('.*?');
        filter.$or = [
          { name: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { areaName: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { address: { $regex: new RegExp(fuzzyPattern, 'i') } },
        ];
      }
    }

    if (req.query.chainOpgId)  filter.chainOpgId = req.query.chainOpgId;
    if (req.query.minReviews)  filter.totalReviews = { ...(filter.totalReviews || {}), $gte: +req.query.minReviews };

    let sortObj;
    if (useTextScore && (sortBy === 'qualityScore' || sortBy === 'relevance')) {
      sortObj = { score: { $meta: 'textScore' }, qualityScore: -1 };
    } else {
      sortObj = { [sortBy]: order === 'asc' ? 1 : -1 };
    }

    try {
      const [spaces, total] = await Promise.all([
        Space.find(filter, useTextScore ? { score: { $meta: 'textScore' } } : undefined)
             .sort(sortObj)
             .limit(+limit)
             .skip((+page - 1) * +limit)
             .lean(),
        Space.countDocuments(filter),
      ]);

      const elapsed = Date.now() - startTime;
      ok(res, { total, page: +page, limit: +limit, pages: Math.ceil(total / +limit), searchTime: elapsed, searchMode: useTextScore ? 'text' : (search ? 'fuzzy' : 'filter'), spaces });
    } catch (e) {
      if (useTextScore && e.message?.includes('text index')) {
        delete filter.$text;
        const sanitized = search.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const fuzzyPattern = sanitized.split('').join('.*?');
        filter.$or = [
          { name: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { areaName: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { address: { $regex: new RegExp(fuzzyPattern, 'i') } },
        ];
        try {
          const [spaces, total] = await Promise.all([
            Space.find(filter).sort({ [sortBy]: order === 'asc' ? 1 : -1 }).limit(+limit).skip((+page - 1) * +limit).lean(),
            Space.countDocuments(filter),
          ]);
          ok(res, { total, page: +page, limit: +limit, pages: Math.ceil(total / +limit), searchMode: 'fuzzy_fallback', spaces });
        } catch (e2) { err(res, e2.message); }
      } else { err(res, e.message); }
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   NEARBY (GEOSPATIAL)
   ═══════════════════════════════════════════════════════════ */

router.get('/nearby',
  query('lat').isFloat(),
  query('lng').isFloat(),
  query('radiusKm').optional().isFloat({ min: 0.1, max: 50 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const { lat, lng, radiusKm = 5, limit = 20, category } = req.query;
    const filter = {
      location: { $near: { $geometry: { type: 'Point', coordinates: [+lng, +lat] }, $maxDistance: +radiusKm * 1000 } },
      deletedAt: null,
    };
    if (category) filter.primaryCategorySlug = category;
    try {
      const spaces = await Space.find(filter).limit(+limit).lean();
      ok(res, { count: spaces.length, spaces });
    } catch (e) { err(res, e.message); }
  }
);

/* ═══════════════════════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════════════════════ */

router.get('/stats', async (_, res) => {
  try {
    if (_statsCache && (Date.now() - _statsCacheAt) < STATS_CACHE_TTL) {
      return ok(res, { stats: _statsCache });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, byCategory, topCities, globalStats, todayCreated, todayUpdated] = await Promise.all([
      Space.countDocuments({ deletedAt: null }),
      Space.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$primaryCategorySlug', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Space.aggregate([
        { $match: { city: { $ne: null }, location: { $ne: null }, deletedAt: null } },
        { $group: { _id: '$city', count: { $sum: 1 }, avgRating: { $avg: '$rating' } } },
        { $sort: { count: -1 } },
        { $limit: 100 }
      ]),
      Space.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: null, avgRating: { $avg: '$rating' }, avgQuality: { $avg: '$qualityScore' }, totalReviews: { $sum: '$totalReviews' }, totalPhotos: { $sum: '$totalPhotos' } } }
      ]),
      Space.countDocuments({ createdAt: { $gte: todayStart } }),
      Space.countDocuments({ updatedAt: { $gte: todayStart } }),
    ]);

    const statsResult = {
      total,
      byCategory,
      topCities,
      averageRating: globalStats[0]?.avgRating?.toFixed(2) || '0.00',
      averageQuality: globalStats[0]?.avgQuality?.toFixed(1) || '0.0',
      totalReviews: globalStats[0]?.totalReviews || 0,
      totalPhotos: globalStats[0]?.totalPhotos || 0,
      cityCount: topCities.length,
      todayStats: { created: todayCreated, updated: todayUpdated },
    };

    _statsCache = statsResult;
    _statsCacheAt = Date.now();
    ok(res, { stats: statsResult });
  } catch (e) { err(res, e.message); }
});

/* ═══════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════ */

router.get('/export', async (req, res) => {
  res.setHeader('Content-disposition', 'attachment; filename=spaces-export.json');
  res.setHeader('Content-type', 'application/json');
  res.write('[\n');
  let first = true;
  const cursor = Space.find({ deletedAt: null }).lean().cursor();
  cursor.on('data', (doc) => { if (!first) res.write(',\n'); res.write(JSON.stringify(doc)); first = false; });
  cursor.on('error', (e) => { if (!res.headersSent) err(res, e.message); else res.end('\n]'); });
  cursor.on('end', () => { res.write('\n]'); res.end(); });
});

/* ═══════════════════════════════════════════════════════════
   PHOTOS (paginated photo library)
   ═══════════════════════════════════════════════════════════ */

router.get('/photos', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 60);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.spaceId && mongoose.isValidObjectId(req.query.spaceId)) {
      filter.spaceId = new mongoose.Types.ObjectId(req.query.spaceId);
    }
    if (req.query.spaceOpgId) filter.spaceOpgId = req.query.spaceOpgId;
    if (req.query.type) filter.type = req.query.type;

    const [photos, total] = await Promise.all([
      Photo.find(filter).sort({ order: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Photo.countDocuments(filter),
    ]);

    ok(res, { photos, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) { err(res, e.message); }
});

/* ═══════════════════════════════════════════════════════════
   DETAIL & PATCH by opgId
   ═══════════════════════════════════════════════════════════ */

async function resolveSpace(req, res, next) {
  const { opgId } = req.params;
  if (!isValidOpgId(opgId)) return err(res, 'Invalid OPG ID format', 400);
  try {
    const space = await Space.findOne({ opgId }).lean();
    if (!space) return err(res, 'Space not found', 404);
    req.space = space;
    next();
  } catch (e) { err(res, e.message); }
}

router.get('/:opgId',
  param('opgId').matches(/^SPC-[A-Z]+-[0-9A-Z]{11,14}$/).withMessage('Invalid space opgId'),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const space = await Space.findById(req.space._id).lean({ virtuals: true });
      if (!space) return err(res, 'Space not found', 404);
      ok(res, { space });
    } catch (e) { err(res, e.message); }
  }
);

router.patch('/:opgId',
  param('opgId').matches(/^SPC-[A-Z]+-[0-9A-Z]{11,14}$/).withMessage('Invalid space opgId'),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    const allowed = ['opg'];
    const set = {};
    for (const k of allowed) if (req.body[k]) set[k] = req.body[k];
    try {
      const space = await Space.findByIdAndUpdate(req.space._id, { $set: set }, { new: true });
      if (!space) return err(res, 'Space not found', 404);
      ok(res, { space });
    } catch (e) { err(res, e.message); }
  }
);

/* ═══════════════════════════════════════════════════════════
   PHOTO DOWNLOAD (Phase 3 — on-demand, URL-first)
   ═══════════════════════════════════════════════════════════ */

/**
 * POST /api/spaces/:opgId/photos/:photoOpgId/download
 * Download a single photo from source, create opg-media asset + variants,
 * flip the space_photos record to owned.
 */
router.post('/:opgId/photos/:photoOpgId/download',
  param('opgId').matches(/^SPC-[A-Z]+-[0-9A-Z]{11,14}$/),
  param('photoOpgId').matches(/^PHT-[A-Z]+-[0-9A-Z]{11,14}$/),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { downloadPhoto } = require('../media/opgMediaWriter');
      const result = await downloadPhoto(req.params.photoOpgId, {
        spaceOpgId: req.space.opgId,
        slug: req.space.slug,
      });
      ok(res, { message: 'Photo downloaded and owned', ...result });
    } catch (e) {
      const status = e.message.includes('Rate limit') ? 429
                   : e.message.includes('not found') ? 404
                   : e.message.includes('already downloaded') ? 409
                   : e.message.includes('MEDIA_DOWNLOAD_ENABLED') ? 503
                   : 500;
      err(res, e.message, status);
    }
  }
);

/**
 * POST /api/spaces/:opgId/photos/download-all
 * Download all un-downloaded photos for a space. Explicit, rate-limited.
 */
router.post('/:opgId/photos/download-all',
  param('opgId').matches(/^SPC-[A-Z]+-[0-9A-Z]{11,14}$/),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { downloadAllForSpace } = require('../media/opgMediaWriter');
      const result = await downloadAllForSpace(req.space.opgId);
      ok(res, { message: `Downloaded ${result.downloaded} photos`, ...result });
    } catch (e) {
      const status = e.message.includes('MEDIA_DOWNLOAD_ENABLED') ? 503
                   : e.message.includes('not found') ? 404
                   : 500;
      err(res, e.message, status);
    }
  }
);

module.exports = router;
