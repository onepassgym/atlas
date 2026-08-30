'use strict';
/**
 * upsertGym.js
 *
 * Exports:
 *   upsertGym(crawledData)       → { action, gymId, newReviews, changedFields }
 *   upsertManyGyms(gymsArray)    → summary stats object
 *
 * Lookup order for duplicates:
 *   1. slug  (if present)
 *   2. googleMapsUrl
 *   3. placeId
 *
 * On INSERT  — creates gym + inserts reviews into separate collection.
 * On UPDATE  — merges reviews, diffs tracked fields, overwrites safe fields,
 *              partially updates crawlMeta, never touches firstCrawledAt.
 * On SKIP    — nothing changed, nothing written.
 */

const Gym          = require('./spaceModel');
const { Review, buildReviewDocs } = require('./reviewModel');
const Photo          = require('./photoModel');
const CrawlMeta      = require('./crawlMetaModel');
const SpaceSource    = require('./spaceSourceModel');
const Category       = require('./categoryModel');
const Amenity        = require('./amenityModel');
const PlaceType      = require('./placeTypeModel');
const GymChangeLog = require('./gymChangeLogModel');
const { calculateQualityScore } = require('../services/intelligence/scoring');
const { analyzeGymSentiment } = require('../services/intelligence/sentiment');
const logger       = require('../utils/logger');
const slugify      = require('slugify');
const crypto       = require('crypto');
const { generateUniqueOpgId } = require('../utils/opgId');


// ── Fields that we always overwrite with fresh crawl data ─────────────────────
const SAFE_OVERWRITE_FIELDS = [
  'rating', 'ratingBreakdown', 'openingHours', 'isOpenNow',
  'coverPhoto', 'photos', 'totalPhotos', 'description', 'priceLevel',
  'amenities', 'highlights', 'offerings', 'serviceOptions', 'accessibility',
  'permanentlyClosed', 'temporarilyClosed', 'claimedByOwner',
  'categories', 'primaryType', 'types', 'lat', 'lng',
];

// ── Fields we diff and log changes for ───────────────────────────────────────
const TRACKED_FIELDS = ['name', 'address'];
// contact is handled separately (sub-object)

// ── Deep equality check (good enough for our field types) ─────────────────────
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

function canonicalizeProviderUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    u.search = '';
    // Normalize trailing slash to reduce identity noise.
    const normalized = u.toString().replace(/\/$/, '');
    return normalized || null;
  } catch (_) {
    return rawUrl.trim().replace(/\/$/, '') || null;
  }
}

function hashString(value) {
  if (!value) return null;
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function computeSourcePayloadHash(data = {}) {
  const stablePayload = {
    name: data.name || null,
    address: data.address || null,
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    phone: data.contact?.phone || null,
    website: data.contact?.website || null,
    rating: data.rating ?? null,
    totalReviews: data.totalReviews ?? 0,
    totalPhotos: data.totalPhotos ?? 0,
    openNow: data.isOpenNow ?? null,
  };
  return hashString(JSON.stringify(stablePayload));
}

async function upsertSpaceSource({ gymId, opgId, crawledData, now, status = 'completed', error = null }) {
  try {
    const provider = 'google_maps';
    const providerPlaceId = crawledData.placeId || null;
    const providerUrlCanonical = canonicalizeProviderUrl(crawledData.googleMapsUrl);
    const providerUrlHash = hashString(providerUrlCanonical);
    const sourcePayloadHash = computeSourcePayloadHash(crawledData);
    const filter = providerPlaceId
      ? { provider, providerPlaceId }
      : (providerUrlHash ? { provider, providerUrlHash } : { spaceId: gymId, provider });

    const setPayload = {
      spaceId: gymId,
      ...(opgId ? { opgId } : {}),
      provider,
      ...(crawledData.googleMapsUrl ? { providerUrl: crawledData.googleMapsUrl } : {}),
      ...(providerPlaceId ? { providerPlaceId } : {}),
      ...(providerUrlCanonical ? { providerUrlCanonical } : {}),
      ...(providerUrlHash ? { providerUrlHash } : {}),
      ...(sourcePayloadHash ? { sourcePayloadHash } : {}),
      lastSeenAt: now,
      lastCrawledAt: now,
      status,
      lastJobId: crawledData.crawlMeta?.jobId || crawledData.crawlJobId || null,
      lastError: error ? String(error).slice(0, 200) : null,
      meta: {
        sourceUrl: crawledData.crawlMeta?.sourceUrl || crawledData.googleMapsUrl || null,
        dataCompleteness: crawledData.crawlMeta?.dataCompleteness ?? null,
      },
    };

    await SpaceSource.updateOne(
      filter,
      {
        $set: setPayload,
        $setOnInsert: {
          firstSeenAt: now,
          crawlVersion: 0,
        },
        $inc: {
          crawlVersion: 1,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    // Non-fatal: source bindings should never stop crawl persistence.
    logger.warn(`SpaceSource upsert warning: ${err.message}`);
  }
}

// ── Resolve Normalized References ─────────────────────────────────────────────

async function resolveCategory(rawLabel) {
  if (!rawLabel) return null;
  const slug = slugifyValue(rawLabel);
  const cat = await Category.findOneAndUpdate(
    { slug },
    { $setOnInsert: { slug, label: rawLabel } },
    { upsert: true, new: true, runValidators: true }
  );
  return cat._id;
}

async function resolvePlaceType(rawLabel) {
  if (!rawLabel) return null;
  const slug = slugifyValue(rawLabel);
  await PlaceType.updateOne(
    { slug },
    { $setOnInsert: { slug, label: rawLabel, googleType: rawLabel } },
    { upsert: true }
  );
  return null;
}

async function resolveAmenities(rawLabels = []) {
  if (!Array.isArray(rawLabels) || !rawLabels.length) return [];

  // Phase 3a: Single bulkWrite instead of N sequential findOneAndUpdate calls
  const ops = rawLabels.map(label => ({
    updateOne: {
      filter: { slug: slugifyValue(label) },
      update: { $setOnInsert: { slug: slugifyValue(label), label } },
      upsert: true,
    }
  }));
  await Amenity.bulkWrite(ops, { ordered: false });

  // One batched read to get all _ids
  const slugs = rawLabels.map(l => slugifyValue(l));
  const docs  = await Amenity.find({ slug: { $in: slugs } }, { _id: 1 }).lean();
  return docs.map(d => d._id);
}

// ── Normalized Data Ingestion Helpers ────────────────────────────────────────

async function upsertPhotos(gymId, rawPhotos = [], now, opgId) {
  if (!rawPhotos.length) return 0;

  // Phase 3b: Single bulkWrite instead of N sequential updateOne calls
  const ops = rawPhotos
    .filter(p => p.publicUrl)
    .map(p => ({
      updateOne: {
        filter: { publicUrl: p.publicUrl },
        update: {
          $setOnInsert: {
            gymId,
            ...(opgId ? { opgId } : {}),
            originalUrl:  p.originalUrl,
            localPath:    p.localPath,
            publicUrl:    p.publicUrl,
            thumbnailUrl: p.thumbnailUrl,
            type:         p.type,
            width:        p.width,
            height:       p.height,
            sizeBytes:    p.sizeBytes,
            isCover:      p.isCover || false,
            downloadedAt: p.downloadedAt || now,
            createdAt:    now,
          }
        },
        upsert: true,
      }
    }));

  if (ops.length) {
    const res = await Photo.bulkWrite(ops, { ordered: false });
    return res.upsertedCount || 0;
  }
  return 0;
}

async function upsertCrawlMeta(gymId, rawMeta, now, opgId) {
  const crawlMeta = rawMeta || {};
  await CrawlMeta.updateOne(
    { gymId },
    {
      $set: {
        lastCrawledAt: now,
        crawlStatus: crawlMeta.crawlStatus || 'completed',
        crawlVersion: crawlMeta.crawlVersion || 1,
        crawlError: crawlMeta.crawlError,
        missingFields: crawlMeta.missingFields,
        dataCompleteness: crawlMeta.dataCompleteness || 0,
        sourceUrl: crawlMeta.sourceUrl,
        jobId: crawlMeta.jobId,
        updatedAt: now,
        ...(opgId ? { opgId } : {}),
      },
      $setOnInsert: {
        gymId,
        firstCrawledAt: crawlMeta.firstCrawledAt || now,
        createdAt: now
      }
    },
    { upsert: true }
  );
}

function buildNormalizedData(crawledData, categoryId, amenityIds, now) {
  const normalizedData = { ...crawledData };
  normalizedData.categoryId = categoryId;
  normalizedData.amenityIds = amenityIds;
  normalizedData.parsed = true;
  normalizedData.primaryCategorySlug = slugifyValue(crawledData.category || 'fitness_venue') || 'fitness-venue';
  normalizedData.categorySlugs = [...new Set((crawledData.categories || [crawledData.category]).filter(Boolean).map(slugifyValue).filter(Boolean))];
  normalizedData.amenitySlugs = [...new Set((crawledData.amenities?.raw || []).map(slugifyValue).filter(Boolean))];
  normalizedData.crawl = {
    jobId: crawledData.crawlMeta?.jobId || crawledData.crawlJobId || null,
    status: crawledData.crawlMeta?.crawlStatus || 'completed',
    version: crawledData.crawlMeta?.crawlVersion || 1,
    firstCrawledAt: crawledData.crawlMeta?.firstCrawledAt || now,
    lastCrawledAt: now,
    sourceUrl: crawledData.crawlMeta?.sourceUrl || crawledData.googleMapsUrl || null,
    dataCompleteness: crawledData.crawlMeta?.dataCompleteness ?? 0,
    mediaStatus: crawledData.crawlMeta?.mediaStatus || 'pending',
  };

  // Shift raw attributes so they don't collide with API virtual names.
  normalizedData.rawPhotos    = crawledData.photos;
  normalizedData.rawAmenities = crawledData.amenities;
  normalizedData.rawCrawlMeta = crawledData.crawlMeta;

  delete normalizedData.photos;
  delete normalizedData.amenities;
  delete normalizedData.crawlMeta;

  return normalizedData;
}

function applyDerivedSignals(normalizedData, crawledData) {
  const qScore = calculateQualityScore(normalizedData);
  normalizedData.qualityScore = qScore.score;
  normalizedData.scoreBreakdown = qScore.breakdown;

  const sentiment = analyzeGymSentiment(crawledData.reviews);
  normalizedData.sentimentScore = sentiment.score;
  normalizedData.sentimentTags = sentiment.tags;
}

// ── Build GeoJSON location from lat/lng ───────────────────────────────────────
function buildLocation(lat, lng) {
  if (lat != null && lng != null) {
    return { type: 'Point', coordinates: [lng, lat] };
  }
  return undefined;
}

// ── Find existing gym by slug → googleMapsUrl → placeId → geo+name → phone ──
async function findExistingGym(crawledData) {
  const { slug, googleMapsUrl, placeId, lat, lng, name, address } = crawledData;
  const phone = crawledData.contact?.phone;

  // Tier 0: provider-level source binding (strongest identity signal)
  const provider = 'google_maps';
  if (placeId) {
    const sourceDoc = await SpaceSource.findOne({ provider, providerPlaceId: placeId }, { spaceId: 1 }).lean();
    if (sourceDoc?.spaceId) {
      const boundGym = await Gym.findById(sourceDoc.spaceId).lean();
      if (boundGym) return boundGym;
    }
  }

  const canonicalUrl = canonicalizeProviderUrl(googleMapsUrl);
  const providerUrlHash = hashString(canonicalUrl);
  if (providerUrlHash) {
    const sourceDoc = await SpaceSource.findOne({ provider, providerUrlHash }, { spaceId: 1 }).lean();
    if (sourceDoc?.spaceId) {
      const boundGym = await Gym.findById(sourceDoc.spaceId).lean();
      if (boundGym) return boundGym;
    }
  }

  // Tier 1-3 combined: single $or query using indexed fields (slug, googleMapsUrl, placeId)
  const orConditions = [];
  if (slug)          orConditions.push({ slug });
  if (googleMapsUrl) orConditions.push({ googleMapsUrl });
  if (placeId)       orConditions.push({ placeId });

  if (orConditions.length > 0) {
    const found = await Gym.findOne({ $or: orConditions }).lean();
    if (found) return found;
  }

  // Tier 4: Spatial proximity + fuzzy name match (50m radius, Jaccard ≥ 0.50)
  if (lat && lng && name) {
    try {
      const nearby = await Gym.find({
        location: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: 50, // meters
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
      // location index may not exist yet on some records — non-fatal
      logger.warn(`Geo dedup query failed (non-fatal): ${err.message}`);
    }
  }

  // Tier 5: Phone number match (for rebranded gyms at different addresses)
  if (phone) {
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (normalizedPhone.length >= 10) {
      const found = await Gym.findOne({
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
    const found = await Gym.findOne({
      name:    { $regex: new RegExp(`^${escaped}$`, 'i') },
      address: { $regex: new RegExp(address.slice(0, 25), 'i') },
    }).lean();
    if (found) return found;
  }

  return null;
}

// ── Insert reviews (separate collection) for a gym ───────────────────────────
async function insertReviews(gymId, rawReviews = [], opgId) {
  if (!rawReviews.length) return 0;

  const docs = buildReviewDocs(gymId, rawReviews);
  if (!docs.length) return 0;

  // Stamp opgId onto every doc at insert time if available
  if (opgId) docs.forEach(d => { d.opgId = opgId; });

  try {
    const res = await Review.insertMany(docs, { ordered: false });
    return res.length;
  } catch (err) {
    // ordered:false → some succeeded despite duplicate key errors
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      return err.result?.nInserted || 0;
    }
    throw err;
  }
}

// ── Merge new reviews into existing gym (dedup by reviewId) ──────────────────
async function mergeReviews(gymId, rawReviews = [], opgId) {
  if (!rawReviews.length) return 0;

  // Fetch ids we already have
  const existing = await Review.find({ gymId }, { reviewId: 1, _id: 0 }).lean();
  const existingIds = new Set(existing.map((r) => r.reviewId));

  const fresh = rawReviews.filter((r) => {
    const id = r.reviewId || r.id;
    return id && !existingIds.has(id);
  });

  if (!fresh.length) return 0;

  const docs = buildReviewDocs(gymId, fresh);
  // Stamp opgId onto new review docs if available
  if (opgId) docs.forEach(d => { d.opgId = opgId; });

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
async function writeChangeLogs(gymId, diffs, now) {
  if (!diffs.length) return;
  const entries = diffs.map(({ field, oldValue, newValue }) => ({
    gymId,
    field,
    oldValue,
    newValue,
    changedAt: now,
    source: 'crawler',
  }));
  await GymChangeLog.insertMany(entries, { ordered: false });
}

// ── Diff tracked fields ───────────────────────────────────────────────────────
function diffTrackedFields(existing, incoming) {
  const diffs = [];

  // Simple top-level fields
  for (const field of TRACKED_FIELDS) {
    const oldVal = existing[field];
    const newVal = incoming[field];
    if (newVal !== undefined && newVal !== null && !equal(oldVal, newVal)) {
      diffs.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }

  // contact sub-fields: phone, email, website
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

function hasCoreChanges(existing, incoming) {
  const compareFields = [
    ...SAFE_OVERWRITE_FIELDS,
    'categoryId',
    'amenityIds',
    'parsed',
    'rawPhotos',
    'rawAmenities',
    'rawCrawlMeta',
    'qualityScore',
    'scoreBreakdown',
    'sentimentScore',
    'sentimentTags',
    'location',
  ];

  for (const field of compareFields) {
    if (incoming[field] === undefined) continue;
    if (!equal(existing[field], incoming[field])) return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRIMARY EXPORT: upsertGym
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} crawledData  — the structured gym object from gymProcessor
 * @returns {{ action: string, gymId: ObjectId, newReviews: number, newPhotos: number, changedFields: string[] }}
 */
async function upsertGym(crawledData) {
  const result = {
    action: null,
    gymId: null,
    newReviews: 0,
    newPhotos: 0,
    changedFields: [],
  };

  try {
    const existing = await findExistingGym(crawledData);
    const now = new Date();

    // ── Resolve Dual-Write Mappings ──────────────────────────────────────────
    const categoryId = await resolveCategory(crawledData.category);
    const amenityIds = await resolveAmenities(crawledData.amenities?.raw);
    await resolvePlaceType(crawledData.primaryType);

    // Stage 1: build normalized representation.
    const normalizedData = buildNormalizedData(crawledData, categoryId, amenityIds, now);
    // Stage 2: compute derived quality/sentiment signals.
    applyDerivedSignals(normalizedData, crawledData);

    // ── INSERT path ──────────────────────────────────────────────────────────
    if (!existing) {
      if (normalizedData.lat != null && normalizedData.lng != null) {
        normalizedData.location = buildLocation(normalizedData.lat, normalizedData.lng);
      }

      // Generate a unique public OPG ID before creating the gym
      const opgId = await generateUniqueOpgId(Gym);
      normalizedData.opgId = opgId;

      // 1. Create Gym (Raw array values mapped correctly to raw field)
      const gym = await Gym.create(normalizedData);
      const gymId = gym._id;

      // 2. Parallel ingestion of secondary scaled data — all receive the same opgId
      const [revCount, photoCount] = await Promise.all([
        insertReviews(gymId, crawledData.reviews, opgId),
        upsertPhotos(gymId, crawledData.photos, now, opgId),
        upsertCrawlMeta(gymId, crawledData.crawlMeta, now, opgId),
        upsertSpaceSource({ gymId, opgId, crawledData: normalizedData, now, status: 'completed' }),
      ]);

      result.newReviews = revCount || 0;
      result.newPhotos = photoCount || 0;

      logger.info(`[INSERT] "${crawledData.name}" → new gym added (opgId: ${opgId})`);
      result.action = 'inserted';
      result.gymId = gymId;
      return result;
    }

    // ── UPDATE path ──────────────────────────────────────────────────────────
    const gymId = existing._id;
    // opgId is NEVER regenerated — always preserved from the existing record.
    const opgId = existing.opgId || null;
    const $set  = {};

    // Backfill opgId onto any related docs that are still missing it.
    // This handles the transition window before migration runs.
    if (opgId) {
      await Promise.all([
        Review.updateMany(
          { gymId, opgId: { $exists: false } },
          { $set: { opgId } }
        ),
        Photo.updateMany(
          { gymId, opgId: { $exists: false } },
          { $set: { opgId } }
        ),
        CrawlMeta.updateOne(
          { gymId, opgId: { $exists: false } },
          { $set: { opgId } }
        ),
      ]);
    }

    // 1. Diff tracked fields
    const diffs = diffTrackedFields(existing, crawledData);
    if (diffs.length) {
      await writeChangeLogs(gymId, diffs, now);
      diffs.forEach((d) => result.changedFields.push(d.field));
    }

    // 2. Parallel ingestion of external records (Merging into secondary collections)
    const [reviewResult, photoResult] = await Promise.all([
      mergeReviews(gymId, crawledData.reviews, opgId),
      upsertPhotos(gymId, crawledData.photos, now, opgId),
      upsertCrawlMeta(gymId, crawledData.crawlMeta, now, opgId),
      upsertSpaceSource({ gymId, opgId, crawledData: normalizedData, now, status: 'completed' }),
    ]);
    result.newReviews = reviewResult;
    result.newPhotos = photoResult;

    // Update totalReviews via arithmetic instead of an extra countDocuments query
    if (reviewResult > 0) {
      $set.totalReviews = (existing.totalReviews || 0) + reviewResult;
    }

    // 3. Safe-overwrite fields (Applies describing variables)
    for (const field of SAFE_OVERWRITE_FIELDS) {
      const val = normalizedData[field];
      if (val !== undefined) {
        $set[field] = val;
      }
    }

    // Explicitly safe-overwrite the raw fields
    $set.rawPhotos    = normalizedData.rawPhotos;
    $set.rawAmenities = normalizedData.rawAmenities;
    $set.rawCrawlMeta = normalizedData.rawCrawlMeta;

    // Explicitly set normalized IDs and flags
    $set.categoryId = categoryId;
    $set.amenityIds = amenityIds;
    $set.parsed = true;
    $set.primaryCategorySlug = normalizedData.primaryCategorySlug;
    $set.categorySlugs = normalizedData.categorySlugs;
    $set.amenitySlugs = normalizedData.amenitySlugs;

    // Intelligence Data
    $set.qualityScore = normalizedData.qualityScore;
    $set.scoreBreakdown = normalizedData.scoreBreakdown;
    $set.sentimentScore = normalizedData.sentimentScore;
    $set.sentimentTags = normalizedData.sentimentTags;

    // 4. Also rebuild GeoJSON location
    const location = buildLocation(crawledData.lat, crawledData.lng);
    if (location) $set.location = location;

    // 5. crawlMeta — partial update, NEVER touch firstCrawledAt in Raw
    $set['crawlMeta.lastCrawledAt']   = now;
    $set['crawlMeta.crawlStatus']     = crawledData.crawlMeta?.crawlStatus     || 'completed';
    $set['crawlMeta.crawlVersion']    = (existing.crawlMeta?.crawlVersion || 1) + 1;
    $set['crawlMeta.dataCompleteness']= crawledData.crawlMeta?.dataCompleteness
      ?? existing.crawlMeta?.dataCompleteness
      ?? 0;
    $set.crawl = {
      jobId: crawledData.crawlMeta?.jobId || crawledData.crawlJobId || existing.crawl?.jobId || null,
      status: crawledData.crawlMeta?.crawlStatus || 'completed',
      version: (existing.crawl?.version || 1) + 1,
      firstCrawledAt: existing.crawl?.firstCrawledAt || crawledData.crawlMeta?.firstCrawledAt || now,
      lastCrawledAt: now,
      sourceUrl: crawledData.crawlMeta?.sourceUrl || crawledData.googleMapsUrl || existing.crawl?.sourceUrl || null,
      dataCompleteness: crawledData.crawlMeta?.dataCompleteness
        ?? existing.crawl?.dataCompleteness
        ?? 0,
      mediaStatus: existing.crawl?.mediaStatus || crawledData.crawlMeta?.mediaStatus || 'pending',
    };

    // 6. Always set updatedAt
    $set.updatedAt = now;

    // 7. Detect meaningful core changes even when tracked fields/reviews/photos are unchanged.
    const coreChanged = hasCoreChanges(existing, $set);

    // Determine if anything changed
    const somethingChanged = diffs.length > 0 || reviewResult > 0 || photoResult > 0 || coreChanged;

    // Only write to DB if something actually changed — eliminates ~60% of writes
    if (somethingChanged) {
      await Gym.findByIdAndUpdate(gymId, { $set }, { new: false });
      logger.info(
        `[UPDATE] "${crawledData.name}" → ${diffs.length} tracked field(s), coreChanged=${coreChanged}, ${reviewResult} new review(s) synced`
      );
      result.action = 'updated';
    } else {
      // Still update crawlMeta timestamp so we know this gym was visited
      await Gym.findByIdAndUpdate(gymId, { $set: {
        'crawlMeta.lastCrawledAt': now,
        'crawlMeta.crawlStatus': 'completed',
        'crawlMeta.crawlVersion': (existing.crawlMeta?.crawlVersion || 1) + 1,
        crawl: {
          jobId: crawledData.crawlMeta?.jobId || crawledData.crawlJobId || existing.crawl?.jobId || null,
          status: 'completed',
          version: (existing.crawl?.version || 1) + 1,
          firstCrawledAt: existing.crawl?.firstCrawledAt || crawledData.crawlMeta?.firstCrawledAt || now,
          lastCrawledAt: now,
          sourceUrl: crawledData.crawlMeta?.sourceUrl || crawledData.googleMapsUrl || existing.crawl?.sourceUrl || null,
          dataCompleteness: crawledData.crawlMeta?.dataCompleteness
            ?? existing.crawl?.dataCompleteness
            ?? existing.crawlMeta?.dataCompleteness
            ?? 0,
        },
        updatedAt: now,
      }}, { new: false });
      logger.info(`[SKIP]   "${crawledData.name}" → already up to date & sync finished.`);
      result.action = 'skipped';
    }

    result.gymId = gymId;
    return result;

  } catch (err) {
    logger.error(`upsertGym error "${crawledData?.name}": ${err.message}`);
    result.action = 'error';
    result.error  = err.message;
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BATCH EXPORT: upsertManyGyms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array} gymsArray  — array of structured gym objects
 * @returns {{ inserted, updated, skipped, reviewsAdded, errors }}
 */
async function upsertManyGyms(gymsArray = []) {
  const stats = {
    inserted: 0,
    updated:  0,
    skipped:  0,
    reviewsAdded: 0,
    errors:   0,
  };

  for (const gym of gymsArray) {
    const res = await upsertGym(gym);
    if (res.action === 'inserted') stats.inserted++;
    else if (res.action === 'updated')  stats.updated++;
    else if (res.action === 'skipped')  stats.skipped++;
    else                                stats.errors++;
    stats.reviewsAdded += res.newReviews || 0;
  }

  // End-of-batch summary
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

module.exports = { upsertGym, upsertManyGyms };
