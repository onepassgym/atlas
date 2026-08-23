'use strict';
/**
 * upsertSpace.js
 *
 * Exports:
 *   upsertSpace(crawledData)       → { action, spaceId, spaceOpgId, newReviews, changedFields }
 *   upsertManySpaces(spacesArray)  → summary stats object
 *
 * Lookup order for duplicates:
 *   1. slug
 *   2. googleMapsUrl
 *   3. placeId
 *   4. geo+name (50m, Jaccard ≥ 0.50)
 *   5. phone (last 10 digits)
 *   6. exact name + partial address
 *
 * On INSERT  — creates space + inserts reviews + captures photo URLs.
 * On UPDATE  — merges reviews, diffs tracked fields, overwrites safe fields.
 * On SKIP    — nothing changed, nothing written.
 */

const Space        = require('./spaceModel');
const { Review, buildReviewDocs } = require('./reviewModel');
const Photo        = require('./photoModel');
const Category     = require('./categoryModel');
const Amenity      = require('./amenityModel');
const ChangeLog    = require('./gymChangeLogModel');
const Location     = require('./locationModel');
const { calculateQualityScore } = require('../services/intelligence/scoring');
const { analyzeGymSentiment } = require('../services/intelligence/sentiment');
const { generateSingleOpgId, reserveOpgIds, generateOpgId } = require('../utils/opgId');
const logger       = require('../utils/logger');
const slugify      = require('slugify');
const { resolveEntity } = require('../services/entityResolver');


// ── Fields that we always overwrite with fresh crawl data ─────────────────────
const SAFE_OVERWRITE_FIELDS = [
  'rating', 'ratingBreakdown', 'openingHours', 'isOpenNow',
  'totalPhotos', 'description', 'priceLevel',
  'highlights', 'offerings', 'serviceOptions', 'accessibility',
  'categorySlugs', 'amenitySlugs', 'tags',
  'lat', 'lng',
];

// ── Fields we diff and log changes for ───────────────────────────────────────
const TRACKED_FIELDS = ['name', 'address'];

// ── Deep equality check ───────────────────────────────────────────────────────
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Name normalization and similarity for fuzzy dedup ─────────────────────────
function normalizeName(name = '') {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(gym|fitness|studio|centre|center|club|the|and|&|pvt|ltd|inc)\b/g, '')
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

function slugifyValue(str) {
  if (!str) return null;
  return str.toString().toLowerCase().trim().replace(/[\s\W-]+/g, '-');
}

// ── Resolve Normalized References ─────────────────────────────────────────────

async function resolveCategory(rawLabel) {
  if (!rawLabel) return null;
  const slug = slugifyValue(rawLabel);
  await Category.findOneAndUpdate(
    { slug },
    { $setOnInsert: { slug, name: rawLabel, key: slug.replace(/-/g, '_') } },
    { upsert: true, new: true, runValidators: true }
  );
  return slug;
}

async function resolveAmenities(rawLabels = []) {
  if (!Array.isArray(rawLabels) || !rawLabels.length) return [];

  const ops = rawLabels.map(label => ({
    updateOne: {
      filter: { slug: slugifyValue(label) },
      update: { $setOnInsert: { slug: slugifyValue(label), name: label, key: slugifyValue(label).replace(/-/g, '_') } },
      upsert: true,
    }
  }));
  await Amenity.bulkWrite(ops, { ordered: false });

  return rawLabels.map(l => slugifyValue(l));
}

// ── Resolve location (Phase 1b) ──────────────────────────────────────────────

async function resolveLocation(city, areaName) {
  if (!city) return { cityOpgId: null, areaOpgId: null };

  const citySlug = slugifyValue(city);
  let cityDoc = await Location.findOne({ slug: citySlug, type: 'city' }).lean();

  if (!cityDoc) {
    const cityOpgId = await generateSingleOpgId('location');
    cityDoc = await Location.findOneAndUpdate(
      { slug: citySlug, type: 'city' },
      { $setOnInsert: { opgId: cityOpgId, slug: citySlug, name: city, displayName: city, type: 'city', country: 'IN', createdVia: 'crawler' } },
      { upsert: true, new: true }
    );
  }

  let areaOpgId = null;
  if (areaName) {
    const areaSlug = slugifyValue(`${areaName}-${city}`);
    let areaDoc = await Location.findOne({ slug: areaSlug, type: 'area' }).lean();
    if (!areaDoc) {
      areaOpgId = await generateSingleOpgId('location');
      areaDoc = await Location.findOneAndUpdate(
        { slug: areaSlug, type: 'area' },
        { $setOnInsert: { opgId: areaOpgId, slug: areaSlug, name: areaName, displayName: `${areaName}, ${city}`, type: 'area', parentOpgId: cityDoc.opgId, country: 'IN', createdVia: 'crawler' } },
        { upsert: true, new: true }
      );
    }
    areaOpgId = areaDoc.opgId;
  }

  return { cityOpgId: cityDoc.opgId, areaOpgId };
}

// ── Upsert photo URL records (no download) ────────────────────────────────────

async function upsertPhotoUrls(spaceId, spaceOpgId, photoUrls = [], now) {
  if (!photoUrls.length) return 0;

  const ops = photoUrls.map((url, idx) => ({
    updateOne: {
      filter: { originalUrl: url, spaceId },
      update: {
        $setOnInsert: {
          opgId: null, // assigned below
          spaceId,
          spaceOpgId,
          originalUrl: url,
          publicUrl: url,
          downloaded: false,
          sourceType: 'google',
          type: idx === 0 ? 'cover' : 'general',
          isCover: idx === 0,
          order: idx,
          createdVia: 'crawler',
          createdAt: now,
        }
      },
      upsert: true,
    }
  }));

  if (ops.length) {
    const photoStartSeq = await reserveOpgIds('photo', ops.length);
    ops.forEach((op, i) => {
      op.updateOne.update.$setOnInsert.opgId = generateOpgId('photo', photoStartSeq + i);
    });

    const res = await Photo.bulkWrite(ops, { ordered: false });
    return res.upsertedCount || 0;
  }
  return 0;
}

// ── Build GeoJSON location from lat/lng ───────────────────────────────────────
function buildLocation(lat, lng) {
  if (lat != null && lng != null) {
    return { type: 'Point', coordinates: [lng, lat] };
  }
  return undefined;
}

// ── Fast exact-match dedup (tiers 1-3: slug, googleMapsUrl, placeId) ─────────
async function _findExact(crawledData) {
  const { slug, googleMapsUrl, placeId } = crawledData;
  const orConditions = [];
  if (slug)          orConditions.push({ slug });
  if (googleMapsUrl) orConditions.push({ googleMapsUrl });
  if (placeId)       orConditions.push({ placeId });
  if (!orConditions.length) return null;
  return Space.findOne({ $or: orConditions }).lean();
}

// ── Find existing space by slug → googleMapsUrl → placeId → geo+name → phone ─
async function findExistingSpace(crawledData) {
  const { slug, googleMapsUrl, placeId, lat, lng, name, address } = crawledData;
  const phone = crawledData.contact?.phone;

  const orConditions = [];
  if (slug)          orConditions.push({ slug });
  if (googleMapsUrl) orConditions.push({ googleMapsUrl });
  if (placeId)       orConditions.push({ placeId });

  if (orConditions.length > 0) {
    const found = await Space.findOne({ $or: orConditions }).lean();
    if (found) return found;
  }

  // Tier 4: Spatial proximity + fuzzy name match (50m radius, Jaccard ≥ 0.50)
  if (lat && lng && name) {
    try {
      const nearby = await Space.find({
        location: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: 50,
          }
        }
      }).limit(10).lean();

      for (const candidate of nearby) {
        if (!candidate.name) continue;
        const sim = jaccardSim(name, candidate.name);
        if (sim >= 0.50) {
          logger.info(`[DEDUP] Geo+name match: "${name}" ≈ "${candidate.name}" (sim=${sim.toFixed(2)})`);
          return candidate;
        }
      }
    } catch (err) {
      logger.warn(`Geo dedup query failed (non-fatal): ${err.message}`);
    }
  }

  // Tier 5: Phone number match
  if (phone) {
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (normalizedPhone.length >= 10) {
      const found = await Space.findOne({
        'contact.phone': { $regex: normalizedPhone.slice(-10) }
      }).lean();
      if (found) {
        logger.info(`[DEDUP] Phone match: "${name}" ↔ "${found.name}" via ${normalizedPhone}`);
        return found;
      }
    }
  }

  // Tier 6: Exact name + partial address match
  if (name && address) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await Space.findOne({
      name:    { $regex: new RegExp(`^${escaped}$`, 'i') },
      address: { $regex: new RegExp(address.slice(0, 25), 'i') },
    }).lean();
    if (found) return found;
  }

  return null;
}

// ── Insert reviews (separate collection) for a space ─────────────────────────
async function insertReviews(spaceId, rawReviews = [], spaceOpgId) {
  if (!rawReviews.length) return 0;

  const docs = buildReviewDocs(spaceId, rawReviews, spaceOpgId);
  if (!docs.length) return 0;

  // Assign individual review opgIds
  const revStartSeq = await reserveOpgIds('review', docs.length);
  docs.forEach((d, i) => { d.opgId = generateOpgId('review', revStartSeq + i); });

  try {
    const res = await Review.insertMany(docs, { ordered: false });
    return res.length;
  } catch (err) {
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      return err.result?.nInserted || 0;
    }
    throw err;
  }
}

// ── Merge new reviews into existing space (dedup by reviewId) ────────────────
async function mergeReviews(spaceId, rawReviews = [], spaceOpgId) {
  if (!rawReviews.length) return 0;

  const existing = await Review.find({ spaceId }, { reviewId: 1, _id: 0 }).lean();
  const existingIds = new Set(existing.map((r) => r.reviewId));

  const fresh = rawReviews.filter((r) => {
    const id = r.reviewId || r.id;
    return id && !existingIds.has(id);
  });

  if (!fresh.length) return 0;

  const docs = buildReviewDocs(spaceId, fresh, spaceOpgId);
  const revStartSeq = await reserveOpgIds('review', docs.length);
  docs.forEach((d, i) => { d.opgId = generateOpgId('review', revStartSeq + i); });

  try {
    const res = await Review.insertMany(docs, { ordered: false });
    return res.length;
  } catch (err) {
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      return err.result?.nInserted || 0;
    }
    throw err;
  }
}

// ── Write changelog entries for changed fields ────────────────────────────────
async function writeChangeLogs(spaceId, diffs, now, spaceOpgId) {
  if (!diffs.length) return;
  const entries = diffs.map(({ field, oldValue, newValue }) => ({
    spaceId,
    spaceOpgId,
    field,
    oldValue,
    newValue,
    changedAt: now,
    source: 'crawler',
  }));
  await ChangeLog.insertMany(entries, { ordered: false });
}

// ── Diff tracked fields ───────────────────────────────────────────────────────
function diffTrackedFields(existing, incoming) {
  const diffs = [];

  for (const field of TRACKED_FIELDS) {
    const oldVal = existing[field];
    const newVal = incoming[field];
    if (newVal !== undefined && newVal !== null && !equal(oldVal, newVal)) {
      diffs.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }

  const contactFields = ['phone', 'email', 'website'];
  for (const cf of contactFields) {
    const oldVal = existing.contact?.[cf];
    const newVal = incoming.contact?.[cf];
    if (newVal !== undefined && newVal !== null && !equal(oldVal, newVal)) {
      diffs.push({ field: `contact.${cf}`, oldValue: oldVal, newValue: newVal });
    }
  }

  return diffs;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIMARY EXPORT: upsertSpace
// ─────────────────────────────────────────────────────────────────────────────

async function upsertSpace(crawledData) {
  const result = {
    action: null,
    spaceId: null,
    spaceOpgId: null,
    newReviews: 0,
    newPhotos: 0,
    changedFields: [],
  };

  try {
    // Tier 1-3: fast exact-match dedup (slug / googleMapsUrl / placeId)
    let existing = await _findExact(crawledData);

    // Tier 4-5: fuzzy dedup via entityResolver (Phase 7B — replaces legacy geo+name+phone)
    if (!existing) {
      const { cityOpgId: earlyCity } = await resolveLocation(
        crawledData.city || crawledData.areaName,
        crawledData.areaName
      ).catch(() => ({ cityOpgId: null }));

      const candidate = {
        placeId:  crawledData.placeId,
        name:     crawledData.name,
        phone:    crawledData.contact?.phone,
        location: crawledData.lat && crawledData.lng
          ? { coordinates: [crawledData.lng, crawledData.lat] }
          : undefined,
      };
      const resolution = await resolveEntity(candidate, earlyCity);

      if (resolution.action === 'needsReview') {
        logger.warn(`[DEDUP] needsReview: "${crawledData.name}" at ${crawledData.address || 'no address'}`);
        result.action = 'needsReview';
        return result;
      }
      if (resolution.action === 'merge' && resolution.entityOpgId) {
        existing = await Space.findOne({ opgId: resolution.entityOpgId }).lean();
      }
    }

    const now = new Date();

    // ── Resolve classification ───────────────────────────────────────────────
    const primaryCategorySlug = await resolveCategory(crawledData.category);
    const amenitySlugs = await resolveAmenities(crawledData.amenities?.raw || []);
    const categorySlugs = crawledData.categories
      ? await Promise.all(crawledData.categories.filter(Boolean).map(resolveCategory))
      : [primaryCategorySlug].filter(Boolean);

    // ── Resolve location (Phase 1b) ──────────────────────────────────────────
    const { cityOpgId, areaOpgId } = await resolveLocation(
      crawledData.city || crawledData.areaName,
      crawledData.areaName
    );

    const normalizedData = { ...crawledData };
    normalizedData.primaryCategorySlug = primaryCategorySlug;
    normalizedData.categorySlugs = [...new Set(categorySlugs.filter(Boolean))];
    normalizedData.amenitySlugs = amenitySlugs;
    normalizedData.cityOpgId = cityOpgId;
    normalizedData.areaOpgId = areaOpgId;
    normalizedData.city = crawledData.city || crawledData.areaName;
    normalizedData.parsed = true;

    // ── Apply Data Intelligence ──────────────────────────────────────────────
    const qScore = calculateQualityScore(normalizedData);
    normalizedData.qualityScore = qScore.score;
    normalizedData.scoreBreakdown = qScore.breakdown;
    normalizedData.dataCompleteness = crawledData.crawlMeta?.dataCompleteness || 0;

    const sentiment = analyzeGymSentiment(crawledData.reviews);
    normalizedData.sentimentScore = sentiment.score;
    normalizedData.sentimentTags = sentiment.tags;

    // ── INSERT path ──────────────────────────────────────────────────────────
    if (!existing) {
      if (normalizedData.lat != null && normalizedData.lng != null) {
        normalizedData.location = buildLocation(normalizedData.lat, normalizedData.lng);
      }

      const opgId = await generateSingleOpgId('space');
      normalizedData.opgId = opgId;
      normalizedData.createdVia = 'crawler';

      // Embed crawl metadata (v5: no separate crawl_meta collection)
      normalizedData.crawl = {
        jobId: crawledData.crawlMeta?.jobId || crawledData.crawlJobId,
        status: 'completed',
        version: 1,
        firstCrawledAt: now,
        lastCrawledAt: now,
        sourceUrl: crawledData.googleMapsUrl,
      };

      // Cover URL (first photo)
      if (crawledData.photoUrls?.length) {
        normalizedData.rawPhotoUrls = crawledData.photoUrls;
        normalizedData.coverUrl = crawledData.photoUrls[0];
        normalizedData.totalPhotos = crawledData.photoUrls.length;
      }

      // Clean out fields that don't belong on the Space model
      delete normalizedData.reviews;
      delete normalizedData.photos;
      delete normalizedData.amenities;
      delete normalizedData.crawlMeta;
      delete normalizedData.crawlJobId;
      delete normalizedData.category;
      delete normalizedData.categories;
      delete normalizedData.primaryType;
      delete normalizedData.types;
      delete normalizedData.geoLocation;

      const space = await Space.create(normalizedData);
      const spaceId = space._id;

      const [revCount, photoCount] = await Promise.all([
        insertReviews(spaceId, crawledData.reviews, opgId),
        upsertPhotoUrls(spaceId, opgId, crawledData.photoUrls || [], now),
      ]);

      result.newReviews = revCount || 0;
      result.newPhotos = photoCount || 0;

      logger.info(`[INSERT] "${crawledData.name}" → new space (opgId: ${opgId})`);
      result.action = 'created';
      result.spaceId = spaceId;
      result.spaceOpgId = opgId;
      return result;
    }

    // ── UPDATE path ──────────────────────────────────────────────────────────
    const spaceId = existing._id;
    const spaceOpgId = existing.opgId || null;
    const $set = {};

    // 1. Diff tracked fields
    const diffs = diffTrackedFields(existing, crawledData);
    if (diffs.length) {
      await writeChangeLogs(spaceId, diffs, now, spaceOpgId);
      diffs.forEach((d) => result.changedFields.push(d.field));
    }

    // 2. Parallel ingestion of external records
    const [reviewResult, photoResult] = await Promise.all([
      mergeReviews(spaceId, crawledData.reviews, spaceOpgId),
      upsertPhotoUrls(spaceId, spaceOpgId, crawledData.photoUrls || [], now),
    ]);
    result.newReviews = reviewResult;
    result.newPhotos = photoResult;

    if (reviewResult > 0) {
      $set.totalReviews = (existing.totalReviews || 0) + reviewResult;
    }

    // 3. Safe-overwrite fields
    for (const field of SAFE_OVERWRITE_FIELDS) {
      const val = normalizedData[field];
      if (val !== undefined) {
        $set[field] = val;
      }
    }

    $set.primaryCategorySlug = primaryCategorySlug;
    $set.categorySlugs = normalizedData.categorySlugs;
    $set.amenitySlugs = amenitySlugs;
    $set.cityOpgId = cityOpgId;
    $set.areaOpgId = areaOpgId;
    $set.parsed = true;

    // Intelligence Data
    $set.qualityScore = normalizedData.qualityScore;
    $set.scoreBreakdown = normalizedData.scoreBreakdown;
    $set.dataCompleteness = normalizedData.dataCompleteness;
    $set.sentimentScore = normalizedData.sentimentScore;
    $set.sentimentTags = normalizedData.sentimentTags;

    // Rebuild GeoJSON location
    const location = buildLocation(crawledData.lat, crawledData.lng);
    if (location) $set.location = location;

    // Update raw photo URLs
    if (crawledData.photoUrls?.length) {
      $set.rawPhotoUrls = crawledData.photoUrls;
      $set.totalPhotos = crawledData.photoUrls.length;
      if (!existing.coverUrl) $set.coverUrl = crawledData.photoUrls[0];
    }

    // crawl — partial update, NEVER touch firstCrawledAt
    $set['crawl.lastCrawledAt'] = now;
    $set['crawl.status'] = 'completed';
    $set['crawl.version'] = (existing.crawl?.version || 1) + 1;

    // Always set updatedAt
    $set.updatedAt = now;

    // Determine if anything changed
    const somethingChanged = diffs.length > 0 || reviewResult > 0 || photoResult > 0;

    if (somethingChanged) {
      await Space.findByIdAndUpdate(spaceId, { $set }, { new: false });
      logger.info(
        `[UPDATE] "${crawledData.name}" → ${diffs.length} field(s) changed, ${reviewResult} new review(s)`
      );
      result.action = 'updated';
    } else {
      await Space.findByIdAndUpdate(spaceId, { $set: {
        'crawl.lastCrawledAt': now,
        'crawl.status': 'completed',
        'crawl.version': (existing.crawl?.version || 1) + 1,
        updatedAt: now,
      }}, { new: false });
      logger.info(`[SKIP]   "${crawledData.name}" → already up to date`);
      result.action = 'skipped';
    }

    result.spaceId = spaceId;
    result.spaceOpgId = spaceOpgId;
    return result;

  } catch (err) {
    logger.error(`upsertSpace error "${crawledData?.name}": ${err.message}`);
    result.action = 'error';
    result.error = err.message;
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BATCH EXPORT: upsertManySpaces
// ─────────────────────────────────────────────────────────────────────────────

async function upsertManySpaces(spacesArray = []) {
  const stats = {
    inserted: 0,
    updated:  0,
    skipped:  0,
    reviewsAdded: 0,
    errors:   0,
  };

  for (const space of spacesArray) {
    const res = await upsertSpace(space);
    if (res.action === 'inserted') stats.inserted++;
    else if (res.action === 'updated')  stats.updated++;
    else if (res.action === 'skipped')  stats.skipped++;
    else                                stats.errors++;
    stats.reviewsAdded += res.newReviews || 0;
  }

  logger.info([
    '\n─── Upsert Summary ───────────────────────────────',
    `  Inserted : ${stats.inserted}`,
    `  Updated  : ${stats.updated}`,
    `  Skipped  : ${stats.skipped}`,
    `  Reviews+ : ${stats.reviewsAdded}`,
    `  Errors   : ${stats.errors}`,
    '──────────────────────────────────────────────────',
  ].join('\n'));

  return stats;
}

module.exports = { upsertSpace, upsertManySpaces };
