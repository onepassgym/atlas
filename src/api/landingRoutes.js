'use strict';
const express  = require('express');
const { query } = require('express-validator');
const router   = express.Router();
const Space    = require('../db/spaceModel');
const { Review } = require('../db/reviewModel');

const { ok, err, validate } = require('../utils/apiUtils');
const { isCategoryGroupSlug, categoryGroupForValue, categoryGroupFilter } = require('../utils/categoryGroups');
const { buildCityFilter, cityVariants } = require('../utils/cityFilter');
const { summarizeLanding, pickReviews } = require('../services/landing');
const { COMPARE_FIELDS } = require('./compareRoutes');

const NEAR_ME = 'near-me';
const MAX_ANALYSED = 1500;             // cap the in-memory pass on huge metros
const CACHE_TTL_MS = 10 * 60 * 1000;   // these numbers move slowly; pages get traffic
const cache = new Map();

/**
 * @swagger
 * /api/spaces/landing:
 *   get:
 *     summary: Live facts for a category × city landing page
 *     description: >
 *       Counts, average rating, review volume, 24/7 / early / late coverage,
 *       popular localities (parsed from addresses), common amenities, top
 *       picks and recent 4★+ reviews for one category group in one city —
 *       what opg-web's /c/:category/:city renders instead of static figures.
 *       `category` is a landing slug (gyms, fitness, yoga, pilates, swimming,
 *       spaces) and matches that group only (the page is about one category).
 *       `city` is alias-aware (gurugram ⇄ gurgaon); `near-me` means no city
 *       filter, or a 10 km radius when lat/lng are given. Cached 10 minutes.
 *     tags: [Spaces]
 *     parameters:
 *       - { in: query, name: category, required: true, schema: { type: string } }
 *       - { in: query, name: city, required: true, schema: { type: string } }
 *       - { in: query, name: lat, schema: { type: number } }
 *       - { in: query, name: lng, schema: { type: number } }
 */
router.get('/',
  query('category').isString().notEmpty(),
  query('city').isString().notEmpty(),
  query('lat').optional().isFloat({ min: -90, max: 90 }),
  query('lng').optional().isFloat({ min: -180, max: 180 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const category = String(req.query.category).toLowerCase().trim();
    const city = String(req.query.city).toLowerCase().trim();
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const hasOrigin = city === NEAR_ME && Number.isFinite(lat) && Number.isFinite(lng);
    // ~1 km grid for the cache key, so nearby visitors share an entry.
    const key = `${category}|${city}|${hasOrigin ? `${lat.toFixed(2)},${lng.toFixed(2)}` : ''}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return ok(res, hit.data);

    try {
      const group = isCategoryGroupSlug(category) ? category : categoryGroupForValue(category);
      const filter = {
        permanentlyClosed: { $ne: true },
        category: categoryGroupFilter(group),
      };
      if (hasOrigin) {
        filter.location = { $geoWithin: { $centerSphere: [[lng, lat], 10 / 6378.1] } };
      } else if (city !== NEAR_ME) {
        filter.areaName = buildCityFilter(city);
      }

      const [total, spaces] = await Promise.all([
        Space.countDocuments(filter),
        Space.find(filter)
          .select(COMPARE_FIELDS)
          .populate('amenityIds', 'slug label')
          .populate('pageSlug', 'slug')
          .sort({ qualityScore: -1, _id: 1 })
          .limit(MAX_ANALYSED)
          .lean(),
      ]);

      const summary = summarizeLanding(spaces, { total, cityVariants: cityVariants(city) });

      // Reviews from the best-regarded spaces, newest first.
      const reviewPool = spaces.slice(0, 60);
      const byOpgId = new Map(reviewPool.map(s => [s.opgId, s]));
      const rawReviews = reviewPool.length
        ? await Review.find({ opgId: { $in: [...byOpgId.keys()] }, rating: { $gte: 4 }, text: { $type: 'string' } })
          .select('opgId authorName authorAvatar rating text publishedAt publishedAtRaw')
          .sort({ publishedAt: -1, createdAt: -1 })
          .limit(300)
          .lean()
        : [];

      const data = {
        category: group,
        city,
        ...summary,
        reviews: pickReviews(rawReviews, byOpgId),
        generatedAt: new Date().toISOString(),
      };
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      ok(res, data);
    } catch (e) { err(res, e.message); }
  }
);

module.exports = router;
