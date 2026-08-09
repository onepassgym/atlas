'use strict';
const Space       = require('../db/spaceModel');
const NeedsReview = require('../db/needsReviewModel');
const { makeOpgId } = require('../utils/opgId');
const logger      = require('../utils/logger');

// ── Normalisation helpers ─────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
}

/** Simple token-set ratio (0.0–1.0). Handles prefix/suffix differences well. */
function tokenSetRatio(a, b) {
  const tokA = new Set(normalizeName(a).split(/\s+/).filter(Boolean));
  const tokB = new Set(normalizeName(b).split(/\s+/).filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return intersection / union;
}

/** Haversine distance in metres between [lng, lat] pairs. */
function haversineM(a, b) {
  const R = 6_371_000;
  const φ1 = a[1] * Math.PI / 180, φ2 = b[1] * Math.PI / 180;
  const Δφ = (b[1] - a[1]) * Math.PI / 180;
  const Δλ = (b[0] - a[0]) * Math.PI / 180;
  const x  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ── Matching thresholds ───────────────────────────────────────────────────────

const TIER = {
  EXACT_PLACE_ID:    { confidence: 1.00, action: 'merge' },
  PHONE_NAME:        { confidence: 0.90, action: 'merge' },
  FUZZY_NAME_GEO:    { confidence: 0.75, action: 'merge' },
  AMBIGUOUS:         { confidence: 0.55, action: 'needsReview' },
  NO_MATCH:          { confidence: 0.00, action: 'new' },
};

const TIER3_NAME_MIN  = 0.85; // fuzzy merge threshold
const TIER3_GEO_MAX_M = 150;  // metres
const TIER4_NAME_MIN  = 0.65; // needsReview threshold
const TIER4_GEO_MAX_M = 300;  // metres

// ── Main resolution function ──────────────────────────────────────────────────

/**
 * Resolve a candidate RawSpaceResult against existing Space documents.
 *
 * @param {{ placeId?, name, phone?, location?: { coordinates: [lng, lat] }, cityOpgId? }} candidate
 * @param {string} cityOpgId
 * @returns {{ action: 'new'|'merge'|'needsReview', entityOpgId?: string, matchTier: number, confidence: number }}
 */
async function resolveEntity(candidate, cityOpgId) {
  const coords = candidate.location?.coordinates || (candidate.lng && candidate.lat ? [candidate.lng, candidate.lat] : null);
  const phone  = normalizePhone(candidate.phone);

  // ── Tier 1: exact placeId ─────────────────────────────────────────────────
  if (candidate.placeId) {
    const match = await Space.findOne({ placeId: candidate.placeId, deletedAt: null }, { opgId: 1 }).lean();
    if (match) {
      return { action: 'merge', entityOpgId: match.opgId, matchTier: 1, confidence: TIER.EXACT_PLACE_ID.confidence };
    }
  }

  // ── Tier 2: phone match + name sanity check (same city) ───────────────────
  if (phone) {
    const phoneMatches = await Space.find({
      'contact.phone': { $regex: phone + '$' },
      cityOpgId:       cityOpgId || undefined,
      deletedAt:       null,
    }, { opgId: 1, name: 1 }).limit(5).lean();

    for (const m of phoneMatches) {
      const nameRatio = tokenSetRatio(candidate.name, m.name);
      if (nameRatio >= 0.50) {
        return { action: 'merge', entityOpgId: m.opgId, matchTier: 2, confidence: TIER.PHONE_NAME.confidence };
      }
    }
  }

  // ── Tiers 3 & 4: geo + fuzzy name ────────────────────────────────────────
  if (coords) {
    const geoMatches = await Space.find({
      location: {
        $near: {
          $geometry:    { type: 'Point', coordinates: coords },
          $maxDistance: TIER4_GEO_MAX_M,
        },
      },
      deletedAt: null,
    }, { opgId: 1, name: 1, location: 1 }).limit(10).lean();

    for (const m of geoMatches) {
      const nameRatio = tokenSetRatio(candidate.name, m.name);
      const distM     = m.location?.coordinates ? haversineM(coords, m.location.coordinates) : Infinity;

      // Tier 3 — high confidence merge
      if (nameRatio >= TIER3_NAME_MIN && distM <= TIER3_GEO_MAX_M) {
        return { action: 'merge', entityOpgId: m.opgId, matchTier: 3, confidence: TIER.FUZZY_NAME_GEO.confidence };
      }

      // Tier 4 — ambiguous, needs human review
      if (nameRatio >= TIER4_NAME_MIN && distM <= TIER4_GEO_MAX_M) {
        await _createNeedsReview(candidate, m.opgId, 4, TIER.AMBIGUOUS.confidence);
        return { action: 'needsReview', entityOpgId: m.opgId, matchTier: 4, confidence: TIER.AMBIGUOUS.confidence };
      }
    }
  }

  // ── Tier 5: no match ──────────────────────────────────────────────────────
  return { action: 'new', matchTier: 5, confidence: TIER.NO_MATCH.confidence };
}

async function _createNeedsReview(candidate, existingOpgId, tier, confidence) {
  try {
    await NeedsReview.create({
      opgId:              makeOpgId('needsReview', { highVolume: false }),
      type:               'dedup_ambiguous',
      candidate: {
        name:     candidate.name,
        phone:    candidate.phone,
        location: candidate.location?.coordinates,
        placeId:  candidate.placeId,
        sourceId: candidate.sourceId,
        source:   candidate.sourceId,
      },
      existingEntityOpgId: existingOpgId,
      matchTier:           tier,
      confidence,
      status:              'pending',
    });
  } catch (err) {
    logger.warn(`[EntityResolver] Failed to create needsReview: ${err.message}`);
  }
}

module.exports = { resolveEntity, tokenSetRatio, normalizePhone };
