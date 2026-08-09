'use strict';
/**
 * SpaceResolver — merges RawSpaceResult[] from multiple sources into a single
 * canonical document for upsertSpace().
 *
 * Conflict resolution rules (authoritative field weights):
 *   - rating/reviews:  google_maps > yelp > justdial > osm
 *   - contact.phone:   google_maps > justdial > yelp > official_website
 *   - openingHours:    google_maps > official_website > yelp > osm
 *   - contact.website: official_website > google_maps > justdial > yelp
 *   - description:     official_website > google_maps > yelp
 *   - lat/lng:         google_maps > osm > yelp > justdial
 *   - address:         google_maps > official_website > yelp > justdial > osm
 *   - amenities:       union of all sources
 *   - categories:      union of all sources
 *   - photos:          union of all sources (deduped)
 *   - reviews:         union of all sources (deduped by reviewId)
 */

const SOURCE_PRIORITY = {
  google_maps:      1,
  yelp:             2,
  official_website: 3,
  justdial:         4,
  osm:              5,
};

function rank(sourceId) {
  return SOURCE_PRIORITY[sourceId] ?? 99;
}

// Field-specific authority overrides
const FIELD_PRIORITY = {
  'contact.website': ['official_website', 'google_maps', 'justdial', 'yelp'],
  'description':     ['official_website', 'google_maps', 'yelp', 'justdial'],
  'lat':             ['google_maps', 'osm', 'yelp', 'justdial'],
  'lng':             ['google_maps', 'osm', 'yelp', 'justdial'],
  'openingHours':    ['google_maps', 'official_website', 'yelp', 'osm'],
  'priceLevel':      ['yelp', 'official_website', 'google_maps'],
};

function bestSourceForField(field, resultsMap) {
  const priority = FIELD_PRIORITY[field] || Object.keys(SOURCE_PRIORITY).sort((a, b) => rank(a) - rank(b));
  for (const srcId of priority) {
    if (resultsMap[srcId]) return resultsMap[srcId];
  }
  return null;
}

class SpaceResolver {
  /**
   * Merge an array of RawSpaceResult objects into one canonical document.
   * @param {RawSpaceResult[]} results
   * @returns {Object} merged document ready for upsertSpace()
   */
  merge(results) {
    if (!results || results.length === 0) return null;
    if (results.length === 1) return this._enrich(results[0]);

    // Index results by sourceId (last one wins if same source provides multiple)
    const bySource = {};
    for (const r of results) {
      bySource[r.sourceId] = r;
    }

    // Sort by authority — most authoritative first
    const sorted = results.slice().sort((a, b) => rank(a.sourceId) - rank(b.sourceId));
    const primary = sorted[0]; // most authoritative

    // Start with the primary source
    const merged = { ...primary };

    // ── Scalar field resolution with field-specific priorities ────────────
    merged.lat         = this._pick('lat',         bySource, primary.lat);
    merged.lng         = this._pick('lng',         bySource, primary.lng);
    merged.description = this._pick('description', bySource, primary.description);
    merged.priceLevel  = this._pick('priceLevel',  bySource, primary.priceLevel);
    merged.openingHours = this._pick('openingHours', bySource, primary.openingHours);

    // Contact: composite from multiple sources
    merged.contact = {
      phone:   this._pickContact('phone',   bySource, primary.contact?.phone),
      website: this._pick('contact.website', bySource, primary.contact?.website),
      email:   this._pickContact('email',   bySource, primary.contact?.email),
      instagram: primary.contact?.instagram || null,
      facebook:  primary.contact?.facebook  || null,
    };

    // Address: use most authoritative non-null
    merged.address = sorted.map(r => r.address).find(Boolean) || null;
    merged.city    = sorted.map(r => r.city).find(Boolean) || null;
    merged.areaName= sorted.map(r => r.areaName).find(Boolean) || null;

    // ── Array merging (union) ─────────────────────────────────────────────

    // categories: union, deduped
    const allCats = results.flatMap(r => r.categories || []).filter(Boolean);
    merged.categories = [...new Set(allCats.map(c => c.toLowerCase()))];

    // amenities: union of all raw labels
    const allAmens = results.flatMap(r => r.amenities?.raw || []).filter(Boolean);
    merged.amenities = { raw: [...new Set(allAmens.map(a => a.toLowerCase()))] };

    // offerings: union
    const allOfferings = results.flatMap(r => r.offerings || []).filter(Boolean);
    merged.offerings = [...new Set(allOfferings)];

    // highlights: union
    const allHighlights = results.flatMap(r => r.highlights || []).filter(Boolean);
    merged.highlights = [...new Set(allHighlights)];

    // photos: union by URL
    const allPhotos = results.flatMap(r => r.photos || r.rawPhotoUrls || []).filter(Boolean);
    merged.rawPhotoUrls = [...new Set(allPhotos)];
    merged.photos       = merged.rawPhotoUrls;

    // reviews: union by reviewId
    const reviewMap = new Map();
    for (const r of results) {
      for (const rev of r.reviews || []) {
        const id = rev.reviewId || rev.id;
        if (id && !reviewMap.has(id)) reviewMap.set(id, rev);
      }
    }
    merged.reviews = [...reviewMap.values()];

    // Track which sources contributed
    merged.sources = [...new Set(results.map(r => r.sourceId))];

    // Use best rating/review count from authoritative sources
    const ratingSource = sorted.find(r => r.rating != null);
    if (ratingSource) {
      merged.rating      = ratingSource.rating;
      merged.totalReviews= ratingSource.totalReviews || merged.totalReviews;
    }

    // hasClasses from any source
    merged.hasClasses = results.some(r => r.hasClasses);

    return this._enrich(merged);
  }

  _pick(field, bySource, fallback) {
    const src = bestSourceForField(field, bySource);
    const isNested = field.includes('.');
    if (!src) return fallback;
    let val;
    if (isNested) {
      const [obj, key] = field.split('.');
      val = src[obj]?.[key];
    } else {
      val = src[field];
    }
    // Only use if non-null and non-empty-array
    if (val == null || (Array.isArray(val) && val.length === 0)) return fallback;
    return val;
  }

  _pickContact(field, bySource, fallback) {
    const priority = ['google_maps', 'justdial', 'yelp', 'official_website'];
    for (const srcId of priority) {
      const val = bySource[srcId]?.contact?.[field];
      if (val) return val;
    }
    return fallback;
  }

  _enrich(result) {
    if (!result.sources) result.sources = [result.sourceId];
    return result;
  }
}

module.exports = new SpaceResolver();
