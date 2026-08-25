'use strict';
const express = require('express');
const router = express.Router();
const Space = require('../db/spaceModel');
const { ok, err } = require('../utils/apiUtils');

/**
 * @swagger
 * tags:
 *   name: Public
 *   description: Publicly available API endpoints
 */

/**
 * @swagger
 * /api/public/spaces:
 *   get:
 *     summary: Retrieve a public list of spaces
 *     tags: [Public]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page (max 50)
 *       - in: query
 *         name: city
 *         schema:
 *           type: string
 *         description: Filter by city name
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by primary category slug (e.g. 'gym', 'yoga_studio')
 *     responses:
 *       200:
 *         description: A paginated list of spaces
 */
router.get('/spaces', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    // Base query: Only return gyms that are not deleted
    const query = { deletedAt: null };
    
    // Optional filters
    if (req.query.city) {
      query.city = new RegExp(`^${req.query.city.trim()}$`, 'i');
    }
    if (req.query.category) {
      query.primaryCategorySlug = req.query.category.trim();
    }

    // Explicitly select safe public fields
    const selectedFields = [
      'name', 'slug', 'primaryCategorySlug', 'type', 
      'city', 'areaName', 'location', 'coordinates', 
      'rating', 'totalReviews', 'priceLevel', 'qualityScore', 
      'coverUrl', 'address', 'isOpen24', 'acceptsWalkIn'
    ].join(' ');

    const [gyms, total] = await Promise.all([
      Space.find(query)
        .select(selectedFields)
        .sort({ qualityScore: -1, totalReviews: -1 }) // Best gyms first
        .skip(skip)
        .limit(limit)
        .lean(),
      Space.countDocuments(query)
    ]);

    ok(res, {
      data: gyms,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    err(res, error.message || 'Internal Server Error');
  }
});

/**
 * @swagger
 * /api/public/spaces/{slug}:
 *   get:
 *     summary: Retrieve a single space by slug
 *     tags: [Public]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Space data
 *       404:
 *         description: Space not found
 */
router.get('/spaces/:slug', async (req, res) => {
  try {
    const gym = await Space.findOne({ slug: req.params.slug, deletedAt: null })
      .select('-stage -stageCompletedAt -stageErrors -nextEnrichAt -consecutiveErrors -parsed -createdVia -fieldConfidence -publishedToCore')
      .lean();

    if (!gym) {
      return res.status(404).json({ success: false, error: 'Gym not found' });
    }

    ok(res, { data: gym });
  } catch (error) {
    err(res, error.message || 'Internal Server Error');
  }
});

module.exports = router;
