'use strict';
const express   = require('express');
const mongoose  = require('mongoose');
const { query, param, validationResult } = require('express-validator');
const router    = express.Router();
const Gym       = require('../db/gymModel');
const Photo     = require('../db/photoModel');

const { ok, err, validate } = require('../utils/apiUtils');
const { isValidOpgId } = require('../utils/opgId');


// ── In-memory stats cache (TTL-based) ─────────────────────────────────────────
let _gymStatsCache = null;
let _gymStatsCacheAt = 0;
const STATS_CACHE_TTL = 30_000; // 30 seconds

/**
 * @swagger
 * tags:
 *   name: Gyms
 *   description: Query and view scraped fitness venues
 */

/* ═══════════════════════════════════════════════════════════
   SEARCH & SUGGESTIONS — High-performance search endpoints
   ═══════════════════════════════════════════════════════════ */

/**
 * @swagger
 * /api/gyms/suggestions:
 *   get:
 *     summary: Get autocomplete suggestions for search input
 *     tags: [Gyms]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Partial search query (min 2 characters)
 *     responses:
 *       200:
 *         description: List of name/area suggestions
 */
router.get('/suggestions', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return ok(res, { suggestions: [] });

  try {
    const sanitized = q.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
    const startsWith = new RegExp(`^${sanitized}`, 'i');
    const contains = new RegExp(sanitized, 'i');

    // Parallel search: names that start with query + areas + chains
    const [nameStartMatches, nameContainsMatches, areaMatches, chainMatches] = await Promise.all([
      Gym.find({ name: startsWith })
         .select('name areaName chainName rating totalReviews qualityScore category coverPhoto')
         .sort({ qualityScore: -1 })
         .limit(5)
         .lean(),
      Gym.find({ name: contains })
         .select('name areaName chainName rating totalReviews qualityScore category coverPhoto')
         .sort({ qualityScore: -1 })
         .limit(5)
         .lean(),
      Gym.aggregate([
        { $match: { areaName: contains } },
        { $group: { _id: '$areaName', count: { $sum: 1 }, avgRating: { $avg: '$rating' } } },
        { $sort: { count: -1 } },
        { $limit: 4 }
      ]),
      Gym.aggregate([
        { $match: { $and: [{ chainName: { $ne: null } }, { chainName: contains }] } },
        { $group: { _id: '$chainName', chainSlug: { $first: '$chainSlug' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 3 }
      ]),
    ]);

    // De-duplicate name matches
    const seenIds = new Set();
    const gymSuggestions = [];
    for (const g of [...nameStartMatches, ...nameContainsMatches]) {
      if (!seenIds.has(g._id.toString())) {
        seenIds.add(g._id.toString());
        gymSuggestions.push({
          type: 'gym',
          id: g._id,
          name: g.name,
          area: g.areaName || null,
          chain: g.chainName || null,
          rating: g.rating,
          reviews: g.totalReviews,
          quality: g.qualityScore,
          category: g.category,
          thumbnail: g.coverPhoto?.thumbnailUrl || null,
        });
      }
      if (gymSuggestions.length >= 6) break;
    }

    const suggestions = [
      ...gymSuggestions,
      ...areaMatches.map(a => ({
        type: 'area',
        name: a._id,
        count: a.count,
        avgRating: a.avgRating?.toFixed(1),
      })),
      ...chainMatches.map(c => ({
        type: 'chain',
        name: c._id,
        slug: c.chainSlug,
        count: c.count,
      })),
    ];

    ok(res, { suggestions });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * /api/gyms/cities:
 *   get:
 *     summary: Get all unique cities/areas for filter dropdown
 *     tags: [Gyms]
 *     responses:
 *       200:
 *         description: List of cities with gym counts
 */
router.get('/cities', async (_, res) => {
  try {
    const cities = await Gym.aggregate([
      { $match: { areaName: { $ne: null, $ne: '' } } },
      { $group: { _id: '$areaName', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);
    ok(res, { cities: cities.map(c => ({ name: c._id, count: c.count })) });
  } catch (e) { err(res, e.message); }
});


/**
 * @swagger
 * /api/gyms:
 *   get:
 *     summary: List gyms with advanced filtering
 *     tags: [Gyms]
 *     parameters:
 *       - in: query
 *         name: city
 *         schema:
 *           type: string
 *         description: Area name (regex search)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: minRating
 *         schema:
 *           type: number
 *           format: float
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
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [rating, totalReviews, name, createdAt, qualityScore, sentimentScore, relevance]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Text search on name/address/area/chain
 *     responses:
 *       200:
 *         description: Paginated list of gyms
 */
// GET /api/gyms  — list with filters
router.get('/',
  query('city').optional().trim(),
  query('category').optional().trim(),
  query('minRating').optional().isFloat({ min: 0, max: 5 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('page').optional().isInt({ min: 1 }),
  query('sortBy').optional().isIn(['rating','totalReviews','name','createdAt','qualityScore','sentimentScore','relevance']),
  async (req, res) => {
    if (validate(req, res)) return;
    const startTime = Date.now();
    const { city, category, minRating, limit = 20, page = 1, sortBy = 'qualityScore', order = 'desc', search } = req.query;
    const filter = {};
    let useTextScore = false;

    if (city)      filter.areaName = { $regex: new RegExp(city.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&'), 'i') };
    if (category)  filter.category = category;
    if (minRating) filter.rating   = { $gte: +minRating };

    if (search) {
      const trimmed = search.trim();
      // Try $text search first for multi-word queries (better relevance)
      if (trimmed.length >= 3) {
        try {
          // Use MongoDB text index for relevance-scored search
          filter.$text = { $search: trimmed };
          useTextScore = true;
        } catch (ignored) {
          // Fallback: regex-based search
          useTextScore = false;
        }
      }
      
      if (!useTextScore) {
        // Regex fallback — character-sequence matching for fuzzy behavior
        const sanitized = trimmed.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&').replace(/\\s+/g, '');
        const fuzzyPattern = sanitized.split('').join('.*?');
        filter.$or = [
          { name: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { areaName: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { chainName: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { address: { $regex: new RegExp(fuzzyPattern, 'i') } },
        ];
      }
    }

    if (req.query.chainSlug)     filter.chainSlug     = req.query.chainSlug;
    if (req.query.isChainMember) filter.isChainMember  = req.query.isChainMember === 'true';
    if (req.query.minReviews)    filter.totalReviews   = { ...(filter.totalReviews || {}), $gte: +req.query.minReviews };

    // Build sort order
    let sortObj;
    if (useTextScore && (sortBy === 'qualityScore' || sortBy === 'relevance')) {
      // Blend text relevance with quality score
      sortObj = { score: { $meta: 'textScore' }, qualityScore: -1 };
    } else {
      sortObj = { [sortBy]: order === 'asc' ? 1 : -1 };
    }

    try {
      const projection = useTextScore 
        ? { score: { $meta: 'textScore' }, crawlMeta: 0 }
        : { crawlMeta: 0 };

      const [gyms, total] = await Promise.all([
        Gym.find(filter, useTextScore ? { score: { $meta: 'textScore' } } : undefined)
           .select('-crawlMeta')
           .populate('categoryId', 'slug label')
           .populate('amenityIds', 'slug label icon')
           .sort(sortObj)
           .limit(+limit)
           .skip((+page - 1) * +limit)
           .lean(),
        Gym.countDocuments(filter),
      ]);

      const elapsed = Date.now() - startTime;

      ok(res, { 
        total, 
        page: +page, 
        limit: +limit, 
        pages: Math.ceil(total / +limit), 
        searchTime: elapsed,
        searchMode: useTextScore ? 'text' : (search ? 'fuzzy' : 'filter'),
        gyms 
      });
    } catch (e) {
      // If $text search fails (e.g. no text index), retry with regex
      if (useTextScore && e.message?.includes('text index')) {
        delete filter.$text;
        const sanitized = search.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const fuzzyPattern = sanitized.split('').join('.*?');
        filter.$or = [
          { name: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { areaName: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { chainName: { $regex: new RegExp(fuzzyPattern, 'i') } },
          { address: { $regex: new RegExp(fuzzyPattern, 'i') } },
        ];
        try {
          const [gyms, total] = await Promise.all([
            Gym.find(filter)
               .select('-crawlMeta')
               .populate('categoryId', 'slug label')
               .populate('amenityIds', 'slug label icon')
               .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
               .limit(+limit)
               .skip((+page - 1) * +limit)
               .lean(),
            Gym.countDocuments(filter),
          ]);
          const elapsed = Date.now() - startTime;
          ok(res, { total, page: +page, limit: +limit, pages: Math.ceil(total / +limit), searchTime: elapsed, searchMode: 'fuzzy_fallback', gyms });
        } catch (e2) { err(res, e2.message); }
      } else {
        err(res, e.message);
      }
    }
  }
);

/**
 * @swagger
 * /api/gyms/nearby:
 *   get:
 *     summary: Find gyms near coordinates (Geospatial)
 *     tags: [Gyms]
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema:
 *           type: number
 *           format: float
 *       - in: query
 *         name: lng
 *         required: true
 *         schema:
 *           type: number
 *           format: float
 *       - in: query
 *         name: radiusKm
 *         schema:
 *           type: number
 *           format: float
 *           default: 5
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: List of nearby gyms
 */
// GET /api/gyms/nearby  — geospatial
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
    };
    if (category) filter.category = category;
    try {
      const gyms = await Gym.find(filter)
        .limit(+limit)
        .populate('categoryId', 'slug label')
        .populate('amenityIds', 'slug label icon')
        .lean();
      ok(res, { count: gyms.length, gyms });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/gyms/stats:
 *   get:
 *     summary: Get overall venue statistics
 *     tags: [Gyms]
 *     responses:
 *       200:
 *         description: Statistics object
 */
// GET /api/gyms/stats
router.get('/stats', async (_, res) => {
  try {
    // Return cached stats if fresh enough
    if (_gymStatsCache && (Date.now() - _gymStatsCacheAt) < STATS_CACHE_TTL) {
      return ok(res, { stats: _gymStatsCache });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, byCategory, topCities, globalStats, todayCreated, todayUpdated] = await Promise.all([
      Gym.countDocuments(),
      Gym.aggregate([
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
        { $lookup: { from: 'gym_categories', localField: '_id', foreignField: '_id', as: 'cat' } },
        { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
        { $project: { _id: { $ifNull: ['$cat.label', 'Unknown'] }, count: 1 } },
        { $sort: { count: -1 } }
      ]),
      Gym.aggregate([
        { $match: { areaName: { $ne: null }, lat: { $ne: null }, lng: { $ne: null } } },
        { $group: { 
            _id: '$areaName', 
            count: { $sum: 1 },
            lat: { $avg: '$lat' },
            lng: { $avg: '$lng' }
        } }, 
        { $sort: { count: -1 } }, 
        { $limit: 100 }
      ]),
      Gym.aggregate([
        { 
          $group: { 
            _id: null, 
            avgRating: { $avg: '$rating' },
            avgQuality: { $avg: '$qualityScore' },
            avgSentiment: { $avg: '$sentimentScore' },
            totalReviews: { $sum: '$totalReviews' },
            totalPhotos: { $sum: '$totalPhotos' }
          } 
        }
      ]),
      Gym.countDocuments({ createdAt: { $gte: todayStart } }),
      Gym.countDocuments({ updatedAt: { $gte: todayStart } })
    ]);

    const statsResult = { 
      total, 
      byCategory, 
      topCities, 
      averageRating: globalStats[0]?.avgRating?.toFixed(2) || '0.00',
      averageQuality: globalStats[0]?.avgQuality?.toFixed(1) || '0.0',
      averageSentiment: globalStats[0]?.avgSentiment?.toFixed(2) || '0.00',
      totalReviews: globalStats[0]?.totalReviews || 0,
      totalPhotos: globalStats[0]?.totalPhotos || 0,
      cityCount: topCities.length,
      todayStats: {
        created: todayCreated,
        updated: todayUpdated
      }
    };

    _gymStatsCache = statsResult;
    _gymStatsCacheAt = Date.now();

    ok(res, { stats: statsResult });
  } catch (e) { err(res, e.message); }
});

// GET /api/gyms/export — download all gym data as JSON
router.get('/export', async (req, res) => {
  res.setHeader('Content-disposition', 'attachment; filename=gyms-export.json');
  res.setHeader('Content-type', 'application/json');
  
  res.write('[\n');
  let first = true;
  
  const cursor = Gym.find().select('-reviews -photos.localPath').lean().cursor();
  
  cursor.on('data', (doc) => {
    if (!first) {
      res.write(',\n');
    }
    res.write(JSON.stringify(doc));
    first = false;
  });
  
  cursor.on('error', (e) => {
    // If headers are already sent, we can't send an error JSON nicely.
    // Ensure stream ends.
    if (!res.headersSent) {
      err(res, e.message);
    } else {
      res.end('\n]'); // attempt graceful recovery
    }
  });

  cursor.on('end', () => {
    res.write('\n]');
    res.end();
  });
});


/**
 * @swagger
 * /api/gyms/{id}:
 *   get:
 *     summary: Get full details for a specific gym
 *     tags: [Gyms]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full gym object with reviews and photos
 *       404:
 *         description: Gym not found
 */
// GET /api/gyms/photos — paginated photo library (MUST be before /:id)
// Queries the gym_photos collection (Photo model) — NOT rawPhotos embedded arrays.
// This surfaces all 26k+ downloaded media records.
router.get('/photos', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 60);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.gymId && mongoose.isValidObjectId(req.query.gymId)) {
      filter.gymId = new mongoose.Types.ObjectId(req.query.gymId);
    }
    if (req.query.type) filter.type = req.query.type;

    const [photos, total, sizeAgg] = await Promise.all([
      Photo.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('gymId', 'name areaName')
        .lean(),
      Photo.countDocuments(filter),
      Photo.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$sizeBytes' } } }]),
    ]);

    const totalSize = sizeAgg[0]?.total || 0;
    ok(res, { photos, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, totalSize });
  } catch (e) { err(res, e.message); }
});

/**
 * resolveGym — shared middleware for /:opgId routes.
 * Validates format, fetches the gym, attaches as req.gym.
 * All subsequent DB queries use req.gym._id (ObjectId) only.
 */
async function resolveGym(req, res, next) {
  const { opgId } = req.params;
  if (!isValidOpgId(opgId)) return err(res, 'Invalid OPG ID format — expected OPG-KEYWORD-XXXX', 400);
  try {
    const gym = await Gym.findOne({ opgId }).lean({ virtuals: true });
    if (!gym) return err(res, 'Gym not found', 404);
    req.gym = gym;
    next();
  } catch (e) { err(res, e.message); }
}

// GET /api/gyms/:opgId
router.get('/:opgId',
  param('opgId')
    .matches(/^OPG-[A-Z]+-[A-Z2-9]{4}$/)
    .withMessage('Invalid OPG ID — expected OPG-KEYWORD-XXXX'),
  resolveGym,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const gym = await Gym.findById(req.gym._id)
        .populate('categoryId', 'slug label description')
        .populate('amenityIds', 'slug label icon')
        .populate('reviews')
        .populate('photos', '-localPath')
        .populate('crawlMeta')
        .lean({ virtuals: true });

      if (!gym) return err(res, 'Gym not found', 404);
      ok(res, { gym });
    } catch (e) { err(res, e.message); }
  }
);

// PATCH /api/gyms/:opgId  — update platform fields only
router.patch('/:opgId',
  param('opgId')
    .matches(/^OPG-[A-Z]+-[A-Z2-9]{4}$/)
    .withMessage('Invalid OPG ID — expected OPG-KEYWORD-XXXX'),
  resolveGym,
  async (req, res) => {
    if (validate(req, res)) return;
    const allowed = ['atlas'];
    const set = {};
    for (const k of allowed) if (req.body[k]) set[k] = req.body[k];
    try {
      const gym = await Gym.findByIdAndUpdate(req.gym._id, { $set: set }, { new: true });
      if (!gym) return err(res, 'Gym not found', 404);
      ok(res, { gym });
    } catch (e) { err(res, e.message); }
  }
);

module.exports = router;
