'use strict';
const slugify     = require('slugify');
const { upsertSpace } = require('../db/upsertSpace');
const { addMediaJob } = require('../queue/queues');
const logger      = require('../utils/logger');

const CATEGORY_MAP = {
  yoga:        'yoga-studio',
  crossfit:    'crossfit',
  pilates:     'pilates',
  martial:     'martial-arts',
  boxing:      'martial-arts',
  karate:      'martial-arts',
  dance:       'dance-studio',
  swim:        'swimming-club',
  'health club':'health-club',
  fitness:     'fitness-center',
  gym:         'gym',
  cycle:       'cycling-studio',
  spinning:    'cycling-studio',
  zumba:       'fitness-center',
  functional:  'fitness-center',
  strength:    'gym',
};

function mapCategory(raw = '') {
  const l = raw.toLowerCase();
  for (const [key, val] of Object.entries(CATEGORY_MAP)) {
    if (l.includes(key)) return val;
  }
  return 'fitness-venue';
}

function calcCompleteness(d) {
  const checks = [d.name, d.lat, d.lng, d.address, d.contact?.phone,
                  d.contact?.website, d.rating, d.totalReviews,
                  d.openingHours?.length, d.photoUrls?.length, d.description, d.category];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}

async function processSpace(raw, areaName, jobId, downloadMedia = false) {
  const result = { action: null, spaceId: null, spaceOpgId: null };

  try {
    const slug = slugify(`${raw.name || 'space'} ${areaName || ''}`, { lower: true, strict: true });

    // ── Build structured document ─────────────────────────────────────────
    const doc = {
      placeId:       raw.placeId       || null,
      googleMapsUrl: raw.googleMapsUrl || null,
      name:          raw.name,
      slug,
      category:      mapCategory(raw.category || ''),
      categories:    [raw.category].filter(Boolean),

      lat: raw.lat || null,
      lng: raw.lng || null,

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

      reviews:        (raw.reviews || []).slice(0, 150),
      reviewsScraped: (raw.reviews || []).length,

      openingHours: raw.openingHours   || [],
      isOpenNow:    raw.isOpenNow      ?? null,

      description:    raw.description    || null,
      priceLevel:     raw.priceLevel     || null,

      amenities:      { raw: raw.amenities || [] },
      highlights:     raw.highlights     || [],
      serviceOptions: raw.serviceOptions || [],

      areaName,
      city: areaName,

      crawlMeta: {
        firstCrawledAt:  new Date(),
        lastCrawledAt:   new Date(),
        crawlStatus:     'completed',
        crawlVersion:    1,
        sourceUrl:       raw.googleMapsUrl,
        jobId,
        dataCompleteness: 0,
      },
    };

    // ── Photo URLs (no download) ──────────────────────────────────────────
    if (raw.photoUrls?.length) {
      doc.photoUrls   = raw.photoUrls;
      doc.totalPhotos = raw.photoUrls.length;
    }

    doc.crawlMeta.dataCompleteness = calcCompleteness(doc);
    doc.crawlJobId = jobId;

    // ── Upsert (dedup + insert-or-update) ─────────────────────────────────
    const upsertResult = await upsertSpace(doc);

    const ACTION_MAP = { inserted: 'created', updated: 'updated', skipped: 'skipped', error: 'error' };
    result.action    = ACTION_MAP[upsertResult.action] || upsertResult.action;
    result.spaceId   = upsertResult.spaceId;
    result.spaceOpgId = upsertResult.spaceOpgId;
    if (upsertResult.error) result.error = upsertResult.error;

  } catch (err) {
    logger.error(`processSpace error "${raw?.name}": ${err.message}`);
    result.action = 'error';
    result.error  = err.message;
  }

  return result;
}

module.exports = { processSpace };
