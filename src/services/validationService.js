'use strict';
const path        = require('path');
const Location    = require('../db/locationModel');
const NeedsReview = require('../db/needsReviewModel');
const { generateSingleOpgId } = require('../utils/opgId');
const logger      = require('../utils/logger');

// taxonomy.json: categorySlug → { searchKeywords, osmTags, appSlug }
let _taxonomy = null;
function getTaxonomy() {
  if (!_taxonomy) _taxonomy = require('../../config/taxonomy.json');
  return _taxonomy;
}

// Build a reverse lookup: keyword → appSlug (used for Maps type → slug mapping)
let _typeMap = null;
function getTypeMap() {
  if (!_typeMap) {
    const taxonomy = getTaxonomy();
    _typeMap = {};
    for (const [slug, def] of Object.entries(taxonomy)) {
      // Map the slug itself
      _typeMap[slug] = def.appSlug;
      // Map each search keyword (normalized)
      for (const kw of def.searchKeywords || []) {
        _typeMap[kw.toLowerCase().replace(/\s+/g, '_')] = def.appSlug;
      }
    }
  }
  return _typeMap;
}

// ── Category mapping ──────────────────────────────────────────────────────────

/**
 * Map a raw Google Maps / OSM type to an OPG app taxonomy slug.
 * Returns { slug, confidence } or null if no mapping exists.
 */
function mapCategory(rawType) {
  if (!rawType) return null;
  const normalised = rawType.toLowerCase().trim().replace(/\s+/g, '_');
  const map = getTypeMap();
  const slug = map[normalised] || map[rawType.toLowerCase()] || null;
  return slug ? { slug, confidence: 0.85 } : null;
}

// ── Geo bounding box validation ───────────────────────────────────────────────

const GEO_SLACK_DEG = 1.0; // ±1° tolerance for peri-urban venues

/**
 * Check that coordinates fall within the city's bounding box (± GEO_SLACK_DEG).
 * Requires the location document to have a `bounds` field.
 * Returns true if valid, false if out-of-bounds (unknown bounds → passes by default).
 */
async function checkGeoBounds(coords, cityOpgId) {
  if (!coords || !cityOpgId) return true;
  try {
    const loc = await Location.findOne({ opgId: cityOpgId }, { bounds: 1 }).lean();
    if (!loc?.bounds) return true; // no bounds defined — pass

    const { minLat, maxLat, minLng, maxLng } = loc.bounds;
    const [lng, lat] = coords;
    return (
      lat >= minLat - GEO_SLACK_DEG && lat <= maxLat + GEO_SLACK_DEG &&
      lng >= minLng - GEO_SLACK_DEG && lng <= maxLng + GEO_SLACK_DEG
    );
  } catch (err) {
    logger.debug(`[ValidationService] checkGeoBounds error: ${err.message}`);
    return true; // fail-open on error
  }
}

// ── Required-field gate ───────────────────────────────────────────────────────

const REQUIRED_FIELDS = [
  { field: 'name',                test: c => !!(c.name && String(c.name).trim().length > 0) },
  { field: 'location.coordinates',test: c => Array.isArray(c.location?.coordinates) && c.location.coordinates.length === 2 },
  { field: 'category',            test: c => !!(c.primaryCategorySlug || c.rawType) },
];

// ── Main validation function ──────────────────────────────────────────────────

/**
 * Validate a candidate before it enters the Space pipeline.
 *
 * @param {object} candidate  - normalized RawSpaceResult or Space draft
 * @param {string} cityOpgId
 * @returns {{ valid: boolean, errors: Array<{field, message}>, needsReview: boolean, needsReviewType?: string }}
 */
async function validateCandidate(candidate, cityOpgId) {
  const errors = [];
  let needsReview = false;
  let needsReviewType = null;

  // Rule 1 — required fields
  const missing = REQUIRED_FIELDS.filter(r => !r.test(candidate)).map(r => r.field);
  if (missing.length) {
    errors.push({ field: missing.join(','), message: `Required fields missing: ${missing.join(', ')}` });
    needsReview    = true;
    needsReviewType= 'required_field_missing';
    await _createNeedsReview({
      type:         'required_field_missing',
      spaceOpgId:   candidate.opgId,
      missingFields: missing,
    });
  }

  // Rule 2 — geo bounds (only if coordinates exist)
  const coords = candidate.location?.coordinates;
  if (coords) {
    const inBounds = await checkGeoBounds(coords, cityOpgId);
    if (!inBounds) {
      errors.push({ field: 'location', message: 'Coordinates outside expected city bounds' });
      needsReview    = true;
      needsReviewType= needsReviewType || 'geo_invalid';
      const loc = await Location.findOne({ opgId: cityOpgId }, { bounds: 1 }).lean();
      await _createNeedsReview({
        type:           'geo_invalid',
        spaceOpgId:     candidate.opgId,
        detectedCoords: coords,
        expectedBounds: loc?.bounds || null,
      });
    }
  }

  // Rule 3 — category mapping (if rawType provided, attempt taxonomy lookup)
  if (candidate.rawType && !candidate.primaryCategorySlug) {
    const mapped = mapCategory(candidate.rawType);
    if (!mapped) {
      needsReview    = true;
      needsReviewType= needsReviewType || 'category_unmapped';
      await _createNeedsReview({
        type:       'category_unmapped',
        spaceOpgId: candidate.opgId,
        rawType:    candidate.rawType,
      });
    } else {
      // Auto-assign mapped category — not a needsReview case
      candidate.primaryCategorySlug = mapped.slug;
    }
  }

  const valid = errors.length === 0;
  return { valid, errors, needsReview, needsReviewType };
}

async function _createNeedsReview(data) {
  try {
    await NeedsReview.create({
      opgId:      await generateSingleOpgId('needsReview'),
      status:     'pending',
      ...data,
    });
  } catch (err) {
    logger.debug(`[ValidationService] needsReview create failed: ${err.message}`);
  }
}

/**
 * Promote a space's validationState.
 * Enforces transition rules (raw→draft→validated→published).
 */
async function promoteState(spaceOpgId, targetState) {
  const Space = require('../db/spaceModel');
  const ALLOWED_TRANSITIONS = {
    draft:      ['raw'],
    validated:  ['draft'],
    published:  ['validated'],
    archived:   ['raw', 'draft', 'validated', 'published'],
  };

  const space = await Space.findOne({ opgId: spaceOpgId }, { validationState: 1 }).lean();
  if (!space) return { action: 'error', error: 'Space not found' };

  const allowed = ALLOWED_TRANSITIONS[targetState] || [];
  if (!allowed.includes(space.validationState)) {
    return { action: 'skipped', reason: `Cannot transition ${space.validationState} → ${targetState}` };
  }

  await Space.updateOne({ opgId: spaceOpgId }, { $set: { validationState: targetState } });
  return { action: 'promoted', from: space.validationState, to: targetState };
}

module.exports = { validateCandidate, mapCategory, checkGeoBounds, promoteState };
