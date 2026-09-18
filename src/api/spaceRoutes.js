'use strict';
const express   = require('express');
const mongoose  = require('mongoose');
const { query, param, validationResult } = require('express-validator');
const router    = express.Router();
const Space       = require('../db/spaceModel');
const Photo     = require('../db/photoModel');
const PageSlug  = require('../db/pageSlugModel');

const { ok, err, validate } = require('../utils/apiUtils');
const { isValidOpgId } = require('../utils/opgId');
const { categoryGroupFilter } = require('../utils/categoryGroups');
const { attachDistanceKm } = require('../utils/geo');

// opg-web's /c/:category/:city route uses 'near-me' as a pseudo-city slug for
// the geolocated variant of the page — there's no areaName to match against,
// so it must skip city filtering entirely rather than search for the literal
// string "near-me".
const NEAR_ME_CITY_SLUG = 'near-me';

/**
 * Builds the `areaName` regex filter for a `city` query param. Tolerant of
 * hyphenated slugs (e.g. "new-delhi") matching a space-separated areaName
 * ("New Delhi") since URL slugs and scraped area names don't share a
 * separator convention.
 */
function buildCityFilter(city) {
  const pattern = city
    .split('-')
    .map(part => part.replace(/[[\]{}()*+?.,\\^$|#-]/g, '\\$&'))
    .join('[- ]');
  return { $regex: new RegExp(pattern, 'i') };
}


// ── In-memory stats cache (TTL-based) ─────────────────────────────────────────
let _spaceStatsCache = null;
let _spaceStatsCacheAt = 0;
const STATS_CACHE_TTL = 30_000; // 30 seconds

// Raw scrape artifacts kept for internal/debug use, never needed by the public
// search/nearby/detail responses — the normalized equivalents (photos virtual,
// amenityIds, crawlMeta virtual) are what the app actually renders.
const RAW_FIELDS_EXCLUDE = '-rawPhotos -rawAmenities -rawCrawlMeta -rawPhotoUrls';

const SEARCHABLE_FIELDS = ['name', 'areaName', 'chainName', 'address', 'category', 'primaryType'];
const SEARCH_STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'at', 'near', 'for']);

/**
 * Builds a word-level match filter: every significant token in the query
 * must appear as a substring in at least one searchable field.
 * Tighter than a full-string character-subsequence match (which matches
 * almost anything containing the query's letters in order) — needed
 * because geo search can't combine with $text, so this is the only
 * relevance signal available when lat/lng is also present, and it directly
 * gates which results are even eligible for the nearest-first distance sort.
 */
function buildTokenMatchOr(trimmed) {
  const exactSanitized = trimmed.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
  const tokens = exactSanitized
    .split(/\s+/)
    .filter(t => t.length >= 2 && !SEARCH_STOPWORDS.has(t.toLowerCase()));
  const words = tokens.length ? tokens : [exactSanitized];

  return {
    $and: words.map(w => ({
      $or: SEARCHABLE_FIELDS.map(f => ({ [f]: { $regex: new RegExp(w, 'i') } })),
    })),
  };
}

/**
 * @swagger
 * tags:
 *   name: Spaces
 *   description: Query and view scraped fitness venues
 */

/* ═══════════════════════════════════════════════════════════
   SEARCH & SUGGESTIONS — High-performance search endpoints
   ═══════════════════════════════════════════════════════════ */

/**
 * @swagger
 * /api/spaces/suggestions:
 *   get:
 *     summary: Get autocomplete suggestions for search input
 *     tags: [Spaces]
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
      Space.find({ name: startsWith })
         .select('name areaName chainName rating totalReviews qualityScore category coverPhoto pageSlug')
         .populate('pageSlug', 'slug')
         .sort({ qualityScore: -1 })
         .limit(5)
         .lean(),
      Space.find({ name: contains })
         .select('name areaName chainName rating totalReviews qualityScore category coverPhoto pageSlug')
         .populate('pageSlug', 'slug')
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
        { $match: { $and: [{ chainName: { $ne: null } }, { chainName: contains }] } },
        { $group: { _id: '$chainName', chainSlug: { $first: '$chainSlug' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 3 }
      ]),
    ]);

    // De-duplicate name matches
    const seenIds = new Set();
    const spaceSuggestions = [];
    for (const g of [...nameStartMatches, ...nameContainsMatches]) {
      if (!seenIds.has(g._id.toString())) {
        seenIds.add(g._id.toString());
        spaceSuggestions.push({
          type: 'space',
          id: g._id,
          name: g.name,
          area: g.areaName || null,
          chain: g.chainName || null,
          rating: g.rating,
          reviews: g.totalReviews,
          quality: g.qualityScore,
          category: g.category,
          thumbnail: g.coverPhoto?.thumbnailUrl || null,
          slug: g.pageSlug?.slug || null,
        });
      }
      if (spaceSuggestions.length >= 6) break;
    }

    const suggestions = [
      ...spaceSuggestions,
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
 * /api/spaces/cities:
 *   get:
 *     summary: Get all unique cities/areas for filter dropdown
 *     tags: [Spaces]
 *     responses:
 *       200:
 *         description: List of cities with space counts
 */
router.get('/cities', async (_, res) => {
  try {
    const cities = await Space.aggregate([
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
 * /api/spaces:
 *   get:
 *     summary: List spaces with advanced filtering
 *     tags: [Spaces]
 *     parameters:
 *       - in: query
 *         name: city
 *         schema:
 *           type: string
 *         description: Area name (regex search). "near-me" skips city filtering.
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: >
 *           Either a raw Space.category value (e.g. "gym") or one of opg-web's
 *           /c/:category/:city landing slugs (gyms, fitness, yoga, pilates,
 *           swimming, spaces), which expands to the matching raw values.
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
 *       - in: query
 *         name: lat
 *         schema:
 *           type: number
 *           format: float
 *         description: Latitude for geospatial nearby search
 *       - in: query
 *         name: lng
 *         schema:
 *           type: number
 *           format: float
 *         description: Longitude for geospatial nearby search
 *       - in: query
 *         name: radiusKm
 *         schema:
 *           type: number
 *           format: float
 *         description: Radius in kilometers (default 5)
 *     responses:
 *       200:
 *         description: >
 *           Paginated list of spaces. Each space carries `distanceKm` — the
 *           great-circle distance from the request's lat/lng, or `null` when
 *           lat/lng weren't both provided (or the space has no coordinates).
 */
// GET /api/spaces  — list with filters
router.get('/',
  query('city').optional().trim(),
  query('category').optional().trim(),
  query('minRating').optional().isFloat({ min: 0, max: 5 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('page').optional().isInt({ min: 1 }),
  query('sortBy').optional().isIn(['rating','totalReviews','name','createdAt','qualityScore','sentimentScore','relevance']),
  query('lat').optional().isFloat(),
  query('lng').optional().isFloat(),
  query('radiusKm').optional().isFloat({ min: 0.1, max: 50 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const startTime = Date.now();
    const { city, category, minRating, limit = 20, page = 1, sortBy = 'qualityScore', order = 'desc', search, lat, lng, radiusKm = 5 } = req.query;
    const filter = {};
    let useTextScore = false;
    // Origin for the response's `distanceKm` field — null on either coordinate
    // means the request carried no location, so distance stays null per-space.
    const originLat = lat !== undefined ? +lat : null;
    const originLng = lng !== undefined ? +lng : null;

    if (city && city.toLowerCase().trim() !== NEAR_ME_CITY_SLUG) filter.areaName = buildCityFilter(city);
    if (category) {
      const normalizedCategory = category.toLowerCase().trim();
      filter.category = categoryGroupFilter(normalizedCategory) ?? normalizedCategory;
    }
    if (minRating) filter.rating   = { $gte: +minRating };

    if (search) {
      const trimmed = search.trim();
      const isOpgId = /^OPG-/i.test(trimmed);
      const isPhone = /^\+?\d{6,15}$/.test(trimmed.replace(/[\s-]/g, ''));
      const exactSanitized = trimmed.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');

      if (isOpgId) {
        filter.opgId = { $regex: new RegExp(exactSanitized, 'i') };
      } else if (isPhone) {
        filter.$or = [
          { 'contact.phone':  { $regex: new RegExp(exactSanitized, 'i') } },
          { 'contact.phone2': { $regex: new RegExp(exactSanitized, 'i') } },
        ];
      } else if (trimmed.length >= 3 && !(lat && lng)) {
        // MongoDB text index — relevance-scored, best option when it's available.
        // Note: MongoDB does not allow $text and $near in the same query, so this
        // path is only taken when lat/lng aren't both present (see the word-match
        // branch below for that case).
        filter.$text = { $search: trimmed };
        useTextScore = true;
      } else {
        // Word-level match: every significant token must appear in a searchable
        // field. This is what backs "closest match to the search string" when a
        // geo $near sort is also active (lat+lng) — $text can't combine with
        // $near, so this filter is the only relevance signal gating which
        // results are even eligible for the nearest-first distance sort. It's
        // deliberately tighter than a full-string character-subsequence match,
        // which would match almost anything containing the query's letters in
        // order and let distance alone decide ranking among mostly-noise hits.
        Object.assign(filter, buildTokenMatchOr(trimmed));
      }
    }

    if (req.query.chainSlug)     filter.chainSlug     = req.query.chainSlug;
    if (req.query.isChainMember) filter.isChainMember  = req.query.isChainMember === 'true';
    if (req.query.minReviews)    filter.totalReviews   = { ...(filter.totalReviews || {}), $gte: +req.query.minReviews };

    if (lat && lng) {
      filter.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: [+lng, +lat] },
          // Only cap distance when the caller explicitly asks for a radius —
          // default stays unbounded so nearest-first sorting always returns
          // records instead of an empty page for sparsely-covered areas.
          ...(req.query.radiusKm ? { $maxDistance: +req.query.radiusKm * 1000 } : {}),
        },
      };
    }

    // Build sort order
    let sortObj;
    if (lat && lng) {
      sortObj = undefined; // $near sorts by distance
    } else if (useTextScore && (sortBy === 'qualityScore' || sortBy === 'relevance')) {
      // Blend text relevance with quality score
      sortObj = { score: { $meta: 'textScore' }, qualityScore: -1 };
    } else {
      sortObj = { [sortBy]: order === 'asc' ? 1 : -1 };
    }

    try {
      const countFilter = { ...filter };
      if (lat && lng) {
        // Since we removed $maxDistance, we count all spaces that have a location
        countFilter.location = { $ne: null };
      }

      const [spaces, total] = await Promise.all([
        Space.find(filter, useTextScore ? { score: { $meta: 'textScore' } } : undefined)
           .select(RAW_FIELDS_EXCLUDE)
           .populate('categoryId', 'slug label')
           .populate('amenityIds', 'slug label icon')
           .populate('pageSlug', 'slug pageData')
           .sort(sortObj)
           .limit(+limit)
           .skip((+page - 1) * +limit)
           .lean(),
        Space.countDocuments(countFilter),
      ]);

      const elapsed = Date.now() - startTime;

      ok(res, {
        total,
        page: +page,
        limit: +limit,
        pages: Math.ceil(total / +limit),
        searchTime: elapsed,
        searchMode: useTextScore ? 'text' : (search ? 'fuzzy' : 'filter'),
        spaces: attachDistanceKm(spaces, originLat, originLng)
      });
    } catch (e) {
      if (useTextScore && e.message?.includes('text index')) {
        delete filter.$text;
        
        // Reset sortObj since textScore is no longer valid
        sortObj = lat && lng ? undefined : { [sortBy === 'relevance' ? 'qualityScore' : sortBy]: order === 'asc' ? 1 : -1 };

        Object.assign(filter, buildTokenMatchOr(search.trim()));
        try {
          const [spaces, total] = await Promise.all([
            Space.find(filter)
               .select(RAW_FIELDS_EXCLUDE)
               .populate('categoryId', 'slug label')
               .populate('amenityIds', 'slug label icon')
               .populate('pageSlug', 'slug pageData')
               .sort(sortObj)
               .limit(+limit)
               .skip((+page - 1) * +limit)
               .lean(),
            Space.countDocuments(filter),
          ]);
          const elapsed = Date.now() - startTime;
          ok(res, { total, page: +page, limit: +limit, pages: Math.ceil(total / +limit), searchTime: elapsed, searchMode: 'fuzzy_fallback', spaces: attachDistanceKm(spaces, originLat, originLng) });
        } catch (e2) { err(res, e2.message); }
      } else {
        err(res, e.message);
      }
    }
  }
);

/**
 * @swagger
 * /api/spaces/nearby:
 *   get:
 *     summary: Find spaces near coordinates (Geospatial)
 *     tags: [Spaces]
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
 *         description: List of nearby spaces
 */
// GET /api/spaces/nearby  — geospatial
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
    if (category) {
      const normalizedCategory = category.toLowerCase().trim();
      filter.category = categoryGroupFilter(normalizedCategory) ?? normalizedCategory;
    }
    try {
      const spaces = await Space.find(filter)
        .select(RAW_FIELDS_EXCLUDE)
        .limit(+limit)
        .populate('categoryId', 'slug label')
        .populate('amenityIds', 'slug label icon')
        .populate('pageSlug', 'slug')
        .lean();
      ok(res, { count: spaces.length, hasMore: spaces.length >= +limit, spaces: attachDistanceKm(spaces, +lat, +lng) });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/spaces/stats:
 *   get:
 *     summary: Get overall venue statistics
 *     tags: [Spaces]
 *     responses:
 *       200:
 *         description: Statistics object
 */
// GET /api/spaces/stats
router.get('/stats', async (_, res) => {
  try {
    // Return cached stats if fresh enough
    if (_spaceStatsCache && (Date.now() - _spaceStatsCacheAt) < STATS_CACHE_TTL) {
      return ok(res, { stats: _spaceStatsCache });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, byCategory, topCities, globalStats, todayCreated, todayUpdated] = await Promise.all([
      Space.countDocuments(),
      Space.aggregate([
        {
          $project: {
            resolvedCategory: {
              $ifNull: ['$category', '$primaryCategorySlug']
            }
          }
        },
        { $group: { _id: { $ifNull: ['$resolvedCategory', 'fitness_venue'] }, count: { $sum: 1 } } },
        { $lookup: { from: 'space_categories', localField: '_id', foreignField: 'slug', as: 'cat' } },
        { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            label: { $ifNull: ['$cat.label', '$_id'] },
            count: 1
          }
        },
        { $sort: { count: -1 } }
      ]),
      Space.aggregate([
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
      Space.aggregate([
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
      Space.countDocuments({ createdAt: { $gte: todayStart } }),
      Space.countDocuments({ updatedAt: { $gte: todayStart } })
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

    _spaceStatsCache = statsResult;
    _spaceStatsCacheAt = Date.now();

    ok(res, { stats: statsResult });
  } catch (e) { err(res, e.message); }
});

/**
 * @swagger
 * tags:
 *   name: Sitemap
 *   description: Endpoints for generating sitemaps
 *
 * /api/spaces/sitemap:
 *   get:
 *     summary: Get all active space slugs for sitemap generation (paginated)
 *     tags: [Spaces, Sitemap]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for sitemap chunking
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10000
 *         description: Items per page (max 50,000 for standard XML sitemaps)
 *     responses:
 *       200:
 *         description: Paginated list of rich sitemap metadata
 */
router.get('/sitemap', async (req, res) => {
  try {
    const baseUrl = process.env.API_ATLAS_BASE_URL ||
      process.env.PUBLIC_BASE_URL || 
      process.env.PROD_PUBLIC_BASE_URL || 
      process.env.DEV_PUBLIC_BASE_URL || 
      'https://onepassgym.com/api-atlas';
    
    // Implement pagination to handle hundreds of thousands (lakhs) of spaces
    // Standard sitemap limit is 50,000 URLs per file. We default to 10,000 to be safe.
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50000, parseInt(req.query.limit) || 10000);
    const skip = (page - 1) * limit;

    const [pageSlugs, total] = await Promise.all([
      PageSlug.find({ isActive: true })
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'spaceId',
          select: 'name description qualityScore rating totalReviews coverPhoto updatedAt'
        })
        .lean(),
      PageSlug.countDocuments({ isActive: true })
    ]);

    const spaces = pageSlugs.map(ps => {
      const space = ps.spaceId || {};
      
      // Calculate dynamic priority based on quality score or rating (0.1 to 1.0)
      let priority = 0.5;
      if (space.qualityScore) {
        priority = 0.3 + (space.qualityScore / 100) * 0.7;
      } else if (space.rating) {
        priority = 0.4 + (space.rating / 5) * 0.6;
      }
      priority = parseFloat(Math.min(1.0, Math.max(0.1, priority)).toFixed(1));

      // Helper to route external image URLs through our proxy endpoint
      // This ensures images appear as first-party assets on our domain
      const getProxiedUrl = (url) => {
        if (!url) return null;
        if (url.match(/googleusercontent\.com|fbcdn\.net|cdninstagram\.com|fitternity\.com|fitmania\.in/)) {
          return `${baseUrl}/api/media/proxy?url=${encodeURIComponent(url)}`;
        }
        return url;
      };

      // Aggregate rich media for image sitemaps (highly valued by AI search)
      const images = [];
      const ogImgUrl = getProxiedUrl(ps.pageData?.ogImage);
      if (ogImgUrl) {
        images.push({ 
          url: ogImgUrl, 
          title: ps.pageData.ogTitle || ps.pageData.seoTitle || space.name 
        });
      }
      
      const coverImgUrl = getProxiedUrl(space.coverPhoto?.publicUrl);
      if (coverImgUrl) {
        images.push({ 
          url: coverImgUrl, 
          title: `${space.name} cover photo` 
        });
      }

      return {
        url: `${baseUrl}/${ps.slug}`,
        slug: ps.slug,
        lastmod: space.updatedAt || ps.updatedAt,
        changefreq: 'weekly',
        priority,
        seo: {
          title: ps.pageData?.seoTitle || space.name || '',
          description: ps.pageData?.metaDescription || space.description || '',
          keywords: ps.pageData?.keywords || []
        },
        images
      };
    });

    ok(res, { 
      spaces,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) { err(res, e.message); }
});

// GET /api/spaces/export — download all space data as JSON
router.get('/export', async (req, res) => {
  res.setHeader('Content-disposition', 'attachment; filename=spaces-export.json');
  res.setHeader('Content-type', 'application/json');
  
  res.write('[\n');
  let first = true;
  
  const cursor = Space.find().select('-reviews -photos.localPath').lean().cursor();
  
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
 * /api/spaces/{slug}:
 *   get:
 *     summary: Get full details for a specific space
 *     tags: [Spaces]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full space object with reviews and photos
 *       404:
 *         description: Space not found
 */
// GET /api/spaces/photos — paginated photo library (MUST be before /:id)
// Queries the space_photos collection (Photo model) — NOT rawPhotos embedded arrays.
// This surfaces all 26k+ downloaded media records.
router.get('/photos', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 60);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.spaceId && mongoose.isValidObjectId(req.query.spaceId)) {
      filter.spaceId = new mongoose.Types.ObjectId(req.query.spaceId);
    }
    if (req.query.type) filter.type = req.query.type;

    const [photos, total, sizeAgg] = await Promise.all([
      Photo.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('spaceId', 'name areaName')
        .lean(),
      Photo.countDocuments(filter),
      Photo.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$sizeBytes' } } }]),
    ]);

    const totalSize = sizeAgg[0]?.total || 0;
    ok(res, { photos, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, totalSize });
  } catch (e) { err(res, e.message); }
});

/**
 * resolveSpace — shared middleware for /:slug routes.
 * Validates format, fetches the space by SEO slug, attaches as req.space.
 * All subsequent DB queries use req.space._id (ObjectId) only.
 */
async function resolveSpace(req, res, next) {
  const { slug } = req.params;
  
  try {
    const slugRecord = await PageSlug.findOne({ slug: slug.toLowerCase(), isActive: true }).lean();
    if (!slugRecord) return err(res, 'Space not found for the given slug', 404);
    
    const space = await Space.findById(slugRecord.spaceId).lean({ virtuals: true });
    if (!space) return err(res, 'Space not found', 404);
    
    req.space = space;
    next();
  } catch (e) { err(res, e.message); }
}

/**
 * @swagger
 * /api/spaces/{slug}/reviews:
 *   get:
 *     summary: Get reviews for a specific space
 *     tags: [Spaces]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated list of reviews for the space
 *       404:
 *         description: Space not found
 */
// GET /api/spaces/:slug/reviews
router.get('/:slug/reviews',
  param('slug').isString().notEmpty().withMessage('Slug is required'),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 20);
      const skip  = (page - 1) * limit;

      const { Review } = require('../db/reviewModel');
      const [reviews, total] = await Promise.all([
        Review.find({ opgId: req.space.opgId })
          .sort({ publishedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Review.countDocuments({ opgId: req.space.opgId })
      ]);

      ok(res, { reviews, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (e) { err(res, e.message); }
  }
);

// GET /api/spaces/:slug
router.get('/:slug',
  param('slug').isString().notEmpty().withMessage('Slug is required'),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const space = await Space.findById(req.space._id)
        .select(RAW_FIELDS_EXCLUDE)
        .populate('categoryId', 'slug label description')
        .populate('amenityIds', 'slug label icon')
        // Capped preview — full pagination lives at GET /:slug/reviews. Some
        // spaces carry 500-1000 reviews post-enrichment; inlining all of them
        // here would balloon every detail-page load for no reason.
        .populate({ path: 'reviews', options: { sort: { publishedAt: -1, createdAt: -1 }, limit: 20 } })
        .populate({ path: 'photos', select: '-localPath', options: { limit: 10 } })
        .populate('crawlMeta')
        .populate('pageSlug', 'slug pageData')
        .lean({ virtuals: true });

      if (!space) return err(res, 'Space not found', 404);
      ok(res, { space });
    } catch (e) { err(res, e.message); }
  }
);

// PATCH /api/spaces/:slug  — update platform fields only
router.patch('/:slug',
  param('slug').isString().notEmpty().withMessage('Slug is required'),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    const allowed = ['atlas'];
    const set = {};
    for (const k of allowed) if (req.body[k]) set[k] = req.body[k];
    try {
      const space = await Space.findByIdAndUpdate(req.space._id, { $set: set }, { new: true });
      if (!space) return err(res, 'Space not found', 404);
      ok(res, { space });
    } catch (e) { err(res, e.message); }
  }
);

// DELETE /api/spaces/:slug — permanently delete a space and all its related records
router.delete('/:slug',
  param('slug').isString().notEmpty().withMessage('Slug is required'),
  resolveSpace,
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { deleteSpaceFull } = require('../db/deleteSpace');
      const deletionStats = await deleteSpaceFull(req.space._id);
      
      ok(res, { 
        message: 'Space and all related records successfully deleted',
        stats: deletionStats
      });
    } catch (e) { err(res, e.message); }
  }
);

module.exports = router;
