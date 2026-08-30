'use strict';
const { getDistance } = require('geolib');
const Space    = require('../db/spaceModel');
const cfg    = require('../../config');
const logger = require('./logger');

const RADIUS = cfg.dedup.radiusMeters;

function normalizeName(name = '') {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(space|fitness|studio|centre|center|club|the|and|&|pvt|ltd|inc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSim(a, b) {
  const sa = new Set(normalizeName(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeName(b).split(' ').filter(Boolean));
  const inter = new Set([...sa].filter(x => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return union.size === 0 ? 0 : inter.size / union.size;
}

async function findDuplicate({ placeId, name, lat, lng, address }) {
  // 1. Exact placeId
  if (placeId) {
    const found = await Space.findOne({ placeId }).lean();
    if (found) return { space: found, confidence: 'high', method: 'placeId' };
  }

  // 2. Spatial proximity ($nearSphere) + name similarity
  if (lat && lng) {
    const nearby = await Space.find({
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: RADIUS,
        }
      }
    }).limit(10).lean();

    for (const c of nearby) {
      if (!c.lat || !c.lng) continue;
      const dist = getDistance(
        { latitude: lat,    longitude: lng },
        { latitude: c.lat,  longitude: c.lng }
      );
      
      const sim = jaccardSim(name, c.name);
      if (sim >= 0.45) {
        return { space: c, confidence: dist < 15 ? 'high' : 'medium', method: 'geoNear+name', dist, sim };
      }
    }
  }

  // 3. Name + partial address
  if (name && address) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await Space.findOne({
      name:    { $regex: new RegExp(`^${escaped}$`, 'i') },
      address: { $regex: new RegExp(address.slice(0, 25), 'i') },
    }).lean();
    if (found) return { space: found, confidence: 'medium', method: 'name+address' };
  }

  return null;
}

/**
 * Merge scraped data into existing space — only fills missing fields.
 * 
 * @deprecated This function is no longer used in the main pipeline.
 * Dedup + merge logic has been integrated into upsertSpace.js.
 * Kept here only for potential standalone script usage.
 */
function mergeSpaceData(existing, incoming) {
  const set = {};
  const filled = [];

  const fill = (field, val) => {
    const cur = existing[field];
    if (val !== null && val !== undefined && val !== '' &&
        (cur === null || cur === undefined || cur === '' || cur === 0)) {
      set[field] = val;
      filled.push(field);
    }
  };

  fill('placeId',       incoming.placeId);
  fill('googleMapsUrl', incoming.googleMapsUrl);
  fill('description',   incoming.description);
  fill('priceLevel',    incoming.priceLevel);
  fill('address',       incoming.address);
  fill('plusCode',      incoming.plusCode);
  fill('isOpenNow',     incoming.isOpenNow);

  // Contact sub-fields
  ['phone', 'website', 'email'].forEach(f => {
    if (incoming.contact?.[f] && !existing.contact?.[f]) {
      set[`contact.${f}`] = incoming.contact[f];
      filled.push(`contact.${f}`);
    }
  });

  // Reviews — update if new count is higher
  if ((incoming.totalReviews || 0) > (existing.totalReviews || 0)) {
    set.totalReviews    = incoming.totalReviews;
    set.rating          = incoming.rating;
    set.ratingBreakdown = incoming.ratingBreakdown;
    set.reviews         = incoming.reviews;
    set.reviewsScraped  = incoming.reviewsScraped;
    filled.push('reviews');
  }

  // Hours — fill if missing
  if (incoming.openingHours?.length && !existing.openingHours?.length) {
    set.openingHours = incoming.openingHours;
    filled.push('openingHours');
  }

  // Amenities / highlights
  if (incoming.amenities?.raw?.length && !existing.amenities?.raw?.length) {
    set['amenities.raw'] = incoming.amenities.raw;
    filled.push('amenities');
  }
  if (incoming.highlights?.length && !existing.highlights?.length) {
    set.highlights = incoming.highlights;
    filled.push('highlights');
  }
  if (incoming.serviceOptions?.length && !existing.serviceOptions?.length) {
    set.serviceOptions = incoming.serviceOptions;
    filled.push('serviceOptions');
  }

  // New photos — append only
  let newPhotos = [];
  if (incoming.photos?.length) {
    const existUrls = new Set((existing.photos || []).map(p => p.originalUrl).filter(Boolean));
    newPhotos = incoming.photos.filter(p => p.originalUrl && !existUrls.has(p.originalUrl));
    if (newPhotos.length) filled.push(`photos(+${newPhotos.length})`);
  }

  // Always update crawl meta
  set['crawlMeta.lastCrawledAt']  = new Date();
  set['crawlMeta.crawlVersion']   = (existing.crawlMeta?.crawlVersion || 1) + 1;
  set['crawlMeta.missingFields']  = filled;
  set['crawlMeta.crawlStatus']    = 'completed';

  return { set, newPhotos, filledFields: filled };
}

module.exports = { findDuplicate, mergeSpaceData, jaccardSim };
