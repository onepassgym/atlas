'use strict';
const express  = require('express');
const { query } = require('express-validator');
const router   = express.Router();
const Space    = require('../db/spaceModel');
const PageSlug = require('../db/pageSlugModel');

const { ok, err, validate } = require('../utils/apiUtils');
const { isValidOpgId } = require('../utils/opgId');
const { categoryGroupForValue, isCategoryGroupSlug, compareFamilyForGroup, compareFamilyFilter } = require('../utils/categoryGroups');
const { compareSpaces, rankCandidates } = require('../services/compare');

// Only the fields the comparison reads — never the raw scrape arrays, reviews
// or photos, so a 3-way compare stays a few KB and a 150-candidate suggest
// scan stays cheap.
const COMPARE_FIELDS = [
  'opgId', 'name', 'slug', 'category', 'areaName', 'address', 'lat', 'lng', 'location',
  'googleMapsUrl', 'coverPhoto', 'totalPhotos', 'contact.phone', 'contact.website',
  'chainName', 'atlas.isVerified', 'atlas.isPartner',
  'rating', 'totalReviews', 'ratingBreakdown', 'qualityScore', 'scoreBreakdown',
  'sentimentScore', 'sentimentTags', 'amenitySlugs', 'amenityIds', 'openingHours',
  'popularTimes', 'operationalData.popularTimesData',
  'permanentlyClosed', 'temporarilyClosed',
].join(' ');

const MIN_COMPARE = 2;
const MAX_COMPARE = 3;

function findForCompare(filter) {
  return Space.find(filter)
    .select(COMPARE_FIELDS)
    .populate('amenityIds', 'slug label')
    .populate('pageSlug', 'slug')
    .lean();
}

function parseOrigin(req) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function parseIdList(raw) {
  return [...new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean))];
}

/**
 * Resolves opgIds and/or SEO slugs to Space docs. Returns a Map keyed by the
 * id exactly as the caller sent it, so the response can preserve their order
 * and name the ones that didn't resolve.
 */
async function resolveSpaces(ids) {
  const opgIds = ids.filter(isValidOpgId).map(id => id.toUpperCase());
  const slugs = ids.filter(id => !isValidOpgId(id)).map(id => id.toLowerCase());

  const [byOpgId, slugRecords] = await Promise.all([
    opgIds.length ? findForCompare({ opgId: { $in: opgIds } }) : [],
    slugs.length ? PageSlug.find({ slug: { $in: slugs }, isActive: true }).select('slug spaceId').lean() : [],
  ]);
  const bySlugPage = slugRecords.length ? await findForCompare({ _id: { $in: slugRecords.map(r => r.spaceId) } }) : [];
  // Some older records only carry Space.slug, with no PageSlug row.
  const unresolvedSlugs = slugs.filter(s => !slugRecords.some(r => r.slug === s));
  const byLegacySlug = unresolvedSlugs.length ? await findForCompare({ slug: { $in: unresolvedSlugs } }) : [];

  const result = new Map();
  for (const id of ids) {
    let space;
    if (isValidOpgId(id)) {
      space = byOpgId.find(s => s.opgId === id.toUpperCase());
    } else {
      const slug = id.toLowerCase();
      const rec = slugRecords.find(r => r.slug === slug);
      space = rec
        ? bySlugPage.find(s => String(s._id) === String(rec.spaceId))
        : byLegacySlug.find(s => s.slug === slug);
    }
    if (space) result.set(id, space);
  }
  return result;
}

/**
 * @swagger
 * /api/spaces/compare:
 *   get:
 *     summary: Compare 2–3 spaces side by side
 *     description: >
 *       Normalises each space into comparable fields (review-weighted rating,
 *       rating distribution, sentiment, canonical amenities, parsed weekly
 *       hours, peak busyness, distance), marks the winner of every dimension,
 *       and returns an overall verdict with reasons and trade-offs. Spaces from
 *       different category groups are still compared but flagged
 *       `mixedCategories: true`.
 *     tags: [Spaces]
 *     parameters:
 *       - in: query
 *         name: ids
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated opgIds and/or SEO slugs (2–3)
 *       - in: query
 *         name: lat
 *         schema: { type: number }
 *       - in: query
 *         name: lng
 *         schema: { type: number }
 *     responses:
 *       200: { description: Comparison payload }
 *       400: { description: Fewer than 2 or more than 3 ids }
 *       404: { description: One or more ids not found (listed in `missing`) }
 */
router.get('/',
  query('ids').isString().notEmpty(),
  query('lat').optional().isFloat({ min: -90, max: 90 }),
  query('lng').optional().isFloat({ min: -180, max: 180 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const ids = parseIdList(req.query.ids);
    if (ids.length < MIN_COMPARE || ids.length > MAX_COMPARE) {
      return err(res, `Provide between ${MIN_COMPARE} and ${MAX_COMPARE} distinct space ids`, 400);
    }
    try {
      const resolved = await resolveSpaces(ids);
      const missing = ids.filter(id => !resolved.has(id));
      if (missing.length) {
        return res.status(404).json({ success: false, error: 'Some spaces were not found', missing });
      }
      // Two different ids (an opgId and a slug) can name the same space.
      const spaces = [...new Map([...resolved.values()].map(s => [String(s._id), s])).values()];
      if (spaces.length < MIN_COMPARE) return err(res, 'Those ids refer to the same space', 400);

      ok(res, { ...compareSpaces(spaces, parseOrigin(req)), generatedAt: new Date().toISOString() });
    } catch (e) { err(res, e.message); }
  }
);

/**
 * @swagger
 * /api/spaces/compare/suggest:
 *   get:
 *     summary: Best-scoring spaces near a location, for "best near you" and "compare with similar nearby"
 *     description: >
 *       Scores spaces of one compare family (gyms+fitness, yoga+pilates, …) within `radiusKm` using the same
 *       0–100 score as /compare and returns the top `limit`. Pass `anchor`
 *       (opgId or slug) to use that space's location and category, and to get
 *       alternatives to it — the anchor itself is returned separately, never in
 *       `results`. When fewer than `limit` qualify, the radius widens once (×3,
 *       capped at 25 km); `radiusKm` in the response is the one actually used.
 *     tags: [Spaces]
 *     parameters:
 *       - { in: query, name: lat, schema: { type: number } }
 *       - { in: query, name: lng, schema: { type: number } }
 *       - { in: query, name: anchor, schema: { type: string } }
 *       - { in: query, name: category, schema: { type: string }, description: "Landing slug (gyms, yoga, …) or raw category" }
 *       - { in: query, name: radiusKm, schema: { type: number, default: 5 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 3, maximum: 5 } }
 *       - { in: query, name: exclude, schema: { type: string }, description: Comma-separated opgIds to leave out }
 *     responses:
 *       200: { description: Ranked candidates }
 *       400: { description: Neither lat/lng nor anchor given }
 */
router.get('/suggest',
  query('lat').optional().isFloat({ min: -90, max: 90 }),
  query('lng').optional().isFloat({ min: -180, max: 180 }),
  query('radiusKm').optional().isFloat({ min: 0.5, max: 25 }),
  query('limit').optional().isInt({ min: 1, max: 5 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const limit = parseInt(req.query.limit, 10) || 3;
    const exclude = new Set(parseIdList(req.query.exclude).map(id => id.toUpperCase()));
    let origin = parseOrigin(req);
    let category = (req.query.category || '').toLowerCase().trim() || null;
    let anchorRecord = null;

    try {
      if (req.query.anchor) {
        const anchorId = String(req.query.anchor).trim();
        const anchor = (await resolveSpaces([anchorId])).get(anchorId);
        if (!anchor) return err(res, 'Anchor space not found', 404);
        exclude.add(anchor.opgId);
        if (!category) category = categoryGroupForValue(anchor.category);
        // The visitor's own location (if shared) still wins for distance;
        // otherwise measure from the anchor.
        const [ranked] = rankCandidates([anchor], origin);
        anchorRecord = ranked || null;
        if (!origin && anchorRecord && anchorRecord.lat !== null) origin = { lat: anchorRecord.lat, lng: anchorRecord.lng };
      }
      if (!origin) return err(res, 'Provide lat/lng or an anchor space', 400);

      // A landing slug widens to its whole compare family (gyms ⇄ fitness);
      // a raw category value ("gym") is resolved to its group first.
      const group = category ? (isCategoryGroupSlug(category) ? category : categoryGroupForValue(category)) : null;
      const categoryFilter = group ? compareFamilyFilter(group) : undefined;
      const baseFilter = {
        permanentlyClosed: { $ne: true },
        rating: { $gt: 0 },
        ...(categoryFilter ? { category: categoryFilter } : {}),
      };

      const requestedRadius = parseFloat(req.query.radiusKm) || 5;
      const search = async (radiusKm) => {
        const near = await findForCompare({
          ...baseFilter,
          location: { $near: { $geometry: { type: 'Point', coordinates: [origin.lng, origin.lat] }, $maxDistance: radiusKm * 1000 } },
        }).limit(80);

        // Many records store a viewport centre instead of their pin (see
        // services/compare spaceCoords), so $near alone misses local spaces
        // filed under a distant point. Pull the same area's top spaces too and
        // let the pin-based distance below decide who is really nearby.
        const areaCounts = new Map();
        for (const s of near) if (s.areaName) areaCounts.set(s.areaName, (areaCounts.get(s.areaName) || 0) + 1);
        const topArea = [...areaCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || anchorRecord?.areaName;
        const sameArea = topArea
          ? await findForCompare({ ...baseFilter, areaName: topArea }).sort({ qualityScore: -1 }).limit(150)
          : [];

        const unique = [...new Map([...near, ...sameArea].map(s => [String(s._id), s])).values()]
          .filter(s => !exclude.has(String(s.opgId || '').toUpperCase()));
        const ranked = rankCandidates(unique, origin).filter(r => r.distanceKm !== null && r.distanceKm <= radiusKm);
        return { ranked, considered: unique.length };
      };

      let radiusKm = requestedRadius;
      let { ranked, considered } = await search(radiusKm);
      if (ranked.length < limit && radiusKm < 25) {
        radiusKm = Math.min(25, radiusKm * 3);
        ({ ranked, considered } = await search(radiusKm));
      }

      ok(res, {
        origin,
        categoryGroup: group,
        categoryFamily: group ? compareFamilyForGroup(group) : null,
        radiusKm,
        candidatesConsidered: considered,
        anchor: anchorRecord,
        results: ranked.slice(0, limit),
      });
    } catch (e) { err(res, e.message); }
  }
);

module.exports = router;
module.exports.COMPARE_FIELDS = COMPARE_FIELDS;
