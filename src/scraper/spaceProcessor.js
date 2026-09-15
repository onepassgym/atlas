'use strict';
const slugify     = require('slugify');
const { upsertSpace } = require('../db/upsertSpace');
const logger      = require('../utils/logger');

const CATEGORY_MAP = {
  gym:          'gym',
  yoga:         'yoga_studio',
  crossfit:     'crossfit',
  pilates:      'pilates_studio',
  martial:      'martial_arts',
  boxing:       'boxing_gym',
  karate:       'martial_arts',
  taekwondo:    'martial_arts',
  dance:        'dance_studio',
  swim:         'swimming_club',
  climb:        'climbing_gym',
  boulder:      'climbing_gym',
  'health club':'health_club',
  fitness:      'fitness_center',
  cowork:       'coworking_space',
  office:       'coworking_space',
  cycle:        'cycling_studio',
  spinning:     'cycling_studio',
  zumba:        'fitness_center',
  functional:   'fitness_center',
  trainer:      'personal_trainer',
  strength:     'gym',
};

function mapCategory(raw = '', name = '') {
  const l = (raw || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(CATEGORY_MAP)) {
    if (l.includes(key)) return val;
  }
  const nl = (name || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(CATEGORY_MAP)) {
    if (nl.includes(key)) return val;
  }
  if (l) {
    const slug = l.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (slug) return slug;
  }
  return 'fitness_venue';
}

function calcCompleteness(d) {
  const checks = [d.name, d.lat, d.lng, d.address, d.contact?.phone,
                  d.contact?.website, d.rating, d.totalReviews,
                  d.openingHours?.length, d.photos?.length, d.description, d.category];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}

async function processSpace(raw, areaName, jobId, downloadMedia = true) {
  const result = { action: null, spaceId: null };

  try {
    const slug = slugify(`${raw.name || 'space'} ${areaName || ''}`, { lower: true, strict: true });

    // ── Build structured document ─────────────────────────────────────────
    const doc = {
      placeId:       raw.placeId       || null,
      googleMapsUrl: raw.googleMapsUrl || null,
      name:          raw.name,
      slug,
      category:      mapCategory(raw.category || '', raw.name || ''),
      categories:    [raw.category].filter(Boolean),
      primaryType:   raw.category || null,

      lat: raw.lat || null,
      lng: raw.lng || null,
      geoLocation: (raw.lat && raw.lng) ? { type: 'Point', coordinates: [raw.lng, raw.lat] } : undefined,

      address:  raw.address  || null,
      plusCode: raw.plusCode || null,

      contact: {
        phone:   raw.phone   || null,
        website: raw.website || null,
        email:   null,
      },

      rating:          raw.rating          || null,
      totalReviews:    raw.totalReviews    || 0,
      ratingBreakdown: raw.ratingBreakdown || {},

      reviews:        raw.reviews || [],
      reviewsScraped: (raw.reviews || []).length,

      openingHours: raw.openingHours   || [],
      isOpenNow:    raw.isOpenNow      ?? null,

      description:    raw.description    || null,
      priceLevel:     raw.priceLevel     || null,
      
      // Phase 1 Semantic Enrichment parsed data
      amenities:      { raw: raw.amenities || [] },
      rawAmenities: {
        has_pool: (raw.amenities || []).some(a => a.toLowerCase().includes('pool')),
        has_sauna: (raw.amenities || []).some(a => a.toLowerCase().includes('sauna')),
        accessible: (raw.amenities || []).some(a => a.toLowerCase().includes('wheelchair') || a.toLowerCase().includes('accessible')),
        free_parking: (raw.amenities || []).some(a => a.toLowerCase().includes('parking') && !a.toLowerCase().includes('paid')),
        has_showers: (raw.amenities || []).some(a => a.toLowerCase().includes('shower') || a.toLowerCase().includes('bathroom')),
      },
      popularTimes:   raw.popularTimes   || [],
      reviewSummary:  raw.reviewSummary  || null,
      
      highlights:     raw.highlights     || [],
      serviceOptions: raw.serviceOptions || [],

      permanentlyClosed: raw.permanentlyClosed || false,

      areaName,
      crawlJobId: jobId,
      crawlMeta: {
        firstCrawledAt:  new Date(),
        lastCrawledAt:   new Date(),
        crawlStatus:     'completed',
        crawlVersion:    1,
        sourceUrl:       raw.googleMapsUrl,
        jobId,
      },
    };

    // ── Media handling (Phase 5: deferred download) ───────────────────────
    // Instead of blocking the scrape loop, we store the raw photoUrls on the document
    if (raw.photoUrls?.length) {
      // Store the photo URL list directly so the space is immediately queryable
      doc.photoUrls   = raw.photoUrls;
      doc.totalPhotos = raw.photoUrls.length;
      doc.crawlMeta.mediaStatus = 'captured';
    }
    doc.crawlMeta.mediaStatus = doc.crawlMeta.mediaStatus || 'none';

    doc.crawlMeta.dataCompleteness = calcCompleteness(doc);

    // ── Upsert (dedup + insert-or-update) ─────────────────────────────────
    const upsertResult = await upsertSpace(doc);

    // Map upsertSpace actions → the action strings worker.js expects
    const ACTION_MAP = { inserted: 'created', updated: 'updated', skipped: 'skipped', error: 'error' };
    result.action = ACTION_MAP[upsertResult.action] || upsertResult.action;
    result.spaceId  = upsertResult.spaceId;
    if (upsertResult.error) result.error = upsertResult.error;


  } catch (err) {
    logger.error(`processSpace error "${raw?.name}": ${err.message}`);
    result.action = 'error';
    result.error  = err.message;
  }

  return result;
}

module.exports = { processSpace };
