'use strict';
/**
 * enrichmentProcessor.js
 *
 * processEnrichmentJob(raw, spaceId, jobId)
 *   → Runs Tasks 1–5 data against an existing space document.
 *   → Calls upsertSpace() with enrichmentPass:true to skip 6-tier dedup.
 *   → Returns: { action, spaceId, newReviews, updatedReviews, newPhotos }
 *
 * This module is imported by the enrichment worker (worker.js) and the
 * CLI script (scripts/enrichNCR.js) — NOT by the standard city-crawl path.
 */

const Space                 = require('../db/spaceModel');
const Photo               = require('../db/photoModel');
const SpaceChangeLog        = require('../db/spaceChangeLogModel');
const { Review, buildReviewDocs, mergeReviewEnrichment } = require('../db/reviewModel');
const logger              = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeChangeLogs(spaceId, diffs, now) {
  if (!diffs?.length) return;
  const entries = diffs.map(({ field, oldValue, newValue }) => ({
    spaceId, field, oldValue, newValue, changedAt: now, source: 'enrichment',
  }));
  await SpaceChangeLog.insertMany(entries, { ordered: false });
}

/**
 * Upsert photo URLs captured during enrichment into space_photos.
 * Only inserts new URLs. Never overwrites existing records that have localPath populated.
 *
 * @param {ObjectId}  spaceId
 * @param {string[]}  urls          - all captured photo URLs
 * @param {string}    sourceType    - 'user' | 'owner' | 'cover' | 'video_thumb' | 'streetview' | 'review_photo'
 * @param {Date}      capturedAt
 */
async function upsertCapturedPhotoUrls(spaceId, urls = [], sourceType = 'user', capturedAt) {
  if (!urls.length) return 0;

  const ops = urls.map(url => ({
    updateOne: {
      filter: { originalUrl: url, spaceId },
      update: {
        $setOnInsert: {
          spaceId,
          originalUrl:  url,
          publicUrl:    null,
          localPath:    null,
          thumbnailUrl: null,
          sourceType,
          downloaded:   false,
          capturedAt:   capturedAt || new Date(),
          type:         sourceType === 'video_thumb' ? 'video' : 'photo',
          createdAt:    capturedAt || new Date(),
        },
      },
      upsert: true,
    },
  }));

  try {
    const res = await Photo.bulkWrite(ops, { ordered: false });
    return res.upsertedCount || 0;
  } catch (err) {
    if (err.code === 11000 || err.name === 'BulkWriteError') return 0;
    throw err;
  }
}

/**
 * Merge new reviews. For existing reviews, call mergeReviewEnrichment
 * to update ownerReply + reviewPhotos + localGuideLevel.
 */
async function handleReviewEnrichment(spaceId, rawReviews, now) {
  if (!rawReviews?.length) return { newReviews: 0, updatedReviews: 0 };

  // Fetch existing review IDs
  const existing = await Review.find({ spaceId }, { reviewId: 1, _id: 0 }).lean();
  const existingIds = new Set(existing.map(r => r.reviewId));

  const fresh = rawReviews.filter(r => {
    const id = r.reviewId || r.id;
    return id && !existingIds.has(id);
  });

  let newReviews = 0;
  if (fresh.length) {
    const docs = buildReviewDocs(spaceId, fresh);
    try {
      const res = await Review.insertMany(docs, { ordered: false });
      newReviews = res.length;
    } catch (err) {
      if (err.code === 11000 || err.name === 'BulkWriteError') {
        newReviews = err.result?.nInserted || 0;
      } else throw err;
    }
  }

  // Update existing reviews (ownerReply, reviewPhotos, localGuideLevel)
  const toUpdate = rawReviews.filter(r => {
    const id = r.reviewId || r.id;
    return id && existingIds.has(id);
  });
  const { updated: updatedReviews } = await mergeReviewEnrichment(spaceId, toUpdate, writeChangeLogs);

  return { newReviews, updatedReviews };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIMARY EXPORT: processEnrichmentJob
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply enrichment scraped data onto an existing space document.
 * enrichmentPass=true → skip 6-tier dedup (spaceId already known).
 *
 * @param {Object}   enriched  - output from scrapeEnrichmentDetail()
 * @param {ObjectId} spaceId     - known space _id
 * @param {string}   jobId     - for logging
 * @returns {{ action, spaceId, newReviews, updatedReviews, newPhotos }}
 */
async function processEnrichmentJob(enriched, spaceId, jobId) {
  const result = { action: null, spaceId, newReviews: 0, updatedReviews: 0, newPhotos: 0 };
  const now = new Date();

  try {
    const existing = await Space.findById(spaceId).lean();
    if (!existing) {
      result.action = 'error';
      result.error  = `Space not found: ${spaceId}`;
      return result;
    }

    const $set = {};
    const diffs = [];

    // ── Task 3: Opening hours ────────────────────────────────────────────────
    if (enriched.openingHours?.length) {
      $set.openingHours = enriched.openingHours;
      $set['operationalData.lastHoursVerifiedAt'] = now;
    }
    if (enriched.specialHours?.length) {
      $set['operationalData.specialHours'] = enriched.specialHours;
    }
    if (enriched.popularTimesData?.length) {
      $set['operationalData.popularTimesData'] = enriched.popularTimesData;
    }
    if (enriched.isOpenNow !== undefined && enriched.isOpenNow !== null) {
      $set.isOpenNow = enriched.isOpenNow;
    }

    // ── Task 4: Amenities & Offerings ────────────────────────────────────────
    if (enriched.deepAmenities?.length) {
      // Merge with existing amenities — don't overwrite if already richer
      const existingAmenities = existing.rawAmenities?.raw || [];
      const merged = [...new Set([...existingAmenities, ...enriched.deepAmenities])];
      $set['rawAmenities.raw'] = merged;
      $set.offerings      = enriched.extraAttributes?.offerings     || existing.offerings     || [];
      $set.serviceOptions = enriched.extraAttributes?.['service options'] || existing.serviceOptions || [];
      $set.accessibility  = enriched.extraAttributes?.accessibility  || existing.accessibility  || [];
      $set.highlights     = enriched.extraAttributes?.highlights     || existing.highlights     || [];
    }
    if (enriched.extraAttributes && Object.keys(enriched.extraAttributes).length) {
      // Store all unmapped sections as-is
      $set.extraAttributes = enriched.extraAttributes;
    }

    // ── Task 4: Pricing ──────────────────────────────────────────────────────
    if (enriched.pricingRawText && !existing.pricing?.rawText) {
      $set['pricing.rawText']    = enriched.pricingRawText;
      $set['pricing.source']     = 'google_maps';
      $set['pricing.capturedAt'] = now;
    }
    if (enriched.priceLevel && !existing.priceLevel) {
      $set.priceLevel = enriched.priceLevel;
    }

    // ── Task 5: Contact enrichment (never overwrite populated values) ────────
    const contactFields = {
      phone:      enriched.phone,
      phone2:     enriched.phone2,
      website:    enriched.website,
      whatsapp:   enriched.whatsapp,
      instagram:  enriched.instagram,
      facebook:   enriched.facebook,
      youtube:    enriched.youtube,
      bookingUrl: enriched.bookingUrl,
      menuUrl:    enriched.menuUrl,
    };
    for (const [field, newVal] of Object.entries(contactFields)) {
      if (newVal == null) continue;
      const oldVal = existing.contact?.[field];
      if (!oldVal && newVal) {
        $set[`contact.${field}`] = newVal;
      } else if (oldVal && newVal && oldVal !== newVal) {
        // Track changes for the diff log (don't overwrite primary phone)
        if (field !== 'phone') {
          $set[`contact.${field}`] = newVal;
          diffs.push({ field: `contact.${field}`, oldValue: oldVal, newValue: newVal });
        }
      }
    }

    // ── Task 1: Cover photo ──────────────────────────────────────────────────
    if (enriched.coverPhotoUrl && !existing.coverPhoto?.publicUrl) {
      $set['coverPhoto.publicUrl'] = enriched.coverPhotoUrl;
    }

    // ── Task 1: Raw photo URLs (deduped union) ───────────────────────────────
    const existingRawUrls = new Set(existing.rawPhotoUrls || []);
    const allNewUrls = [
      ...(enriched.allPhotoUrls || []),
      ...(enriched.heroPhotoUrls || []),
    ].filter(u => u && !existingRawUrls.has(u));

    if (allNewUrls.length) {
      $set.rawPhotoUrls = [...existingRawUrls, ...allNewUrls];
      $set.totalPhotos  = $set.rawPhotoUrls.length;
    }

    // ── Enrichment meta ──────────────────────────────────────────────────────
    $set['enrichmentMeta.lastAttempt'] = now;
    $set['enrichmentMeta.lastSuccess'] = now;
    $set['enrichmentMeta.status']      = 'success';
    $set['enrichmentMeta.consecutiveErrors'] = 0;
    $set['crawl.lastCrawledAt'] = now;
    $set['crawl.status'] = 'completed';
    $set['crawl.dataCompleteness'] = Math.max(
      existing.crawl?.dataCompleteness || 0,
      existing.rawCrawlMeta?.dataCompleteness || 0,
      existing.crawlMeta?.dataCompleteness || 0
    );
    $set.updatedAt = now;

    // ── Write changelog ──────────────────────────────────────────────────────
    if (diffs.length) await writeChangeLogs(spaceId, diffs, now);

    // ── Write space document ────────────────────────────────────────────────────
    if (Object.keys($set).length > 3) { // more than just timestamps
      await Space.findByIdAndUpdate(spaceId, { $set }, { new: false });
      result.action = 'enriched';
    } else {
      result.action = 'skipped';
    }

    // ── Task 2: Reviews ───────────────────────────────────────────────────────
    const { newReviews, updatedReviews } = await handleReviewEnrichment(spaceId, enriched.reviews, now);
    result.newReviews     = newReviews;
    result.updatedReviews = updatedReviews;

    // Update totalReviews count if new reviews added
    if (newReviews > 0) {
      await Space.findByIdAndUpdate(spaceId, {
        $inc: { totalReviews: newReviews },
        $set: { reviewsScraped: (existing.reviewsScraped || 0) + newReviews },
      });
    }

    // ── Task 1: Upsert photo URLs into space_photos ────────────────────────────
    const capturedAt = enriched.scrapedAt || now;
    const [heroCount, videoCount] = await Promise.all([
      upsertCapturedPhotoUrls(spaceId, enriched.allPhotoUrls || [], 'user', capturedAt),
      upsertCapturedPhotoUrls(spaceId, enriched.videoThumbUrls || [], 'video_thumb', capturedAt),
    ]);
    if (enriched.coverPhotoUrl) {
      await upsertCapturedPhotoUrls(spaceId, [enriched.coverPhotoUrl], 'cover', capturedAt);
    }

    // Task 2: Review photo URLs
    const reviewPhotoUrls = (enriched.reviews || []).flatMap(r => r.reviewPhotos || []).filter(Boolean);
    const reviewPhotoCount = await upsertCapturedPhotoUrls(spaceId, [...new Set(reviewPhotoUrls)], 'review_photo', capturedAt);

    result.newPhotos = heroCount + videoCount + reviewPhotoCount;

    logger.info(`[ENRICH] "${existing.name}" → action:${result.action} +${result.newReviews}rev +${result.updatedReviews}upd +${result.newPhotos}photos`);
    return result;

  } catch (err) {
    logger.error(`processEnrichmentJob error [${spaceId}]: ${err.message}`);
    // Mark enrichment error on space doc
    try {
      await Space.findByIdAndUpdate(spaceId, {
        $set: {
          'enrichmentMeta.lastAttempt':       now,
          'enrichmentMeta.status':             'failed',
          'enrichmentMeta.error':              err.message.slice(0, 200),
          'crawl.lastCrawledAt': now,
          'crawl.status': 'failed',
        },
        $inc: { 'enrichmentMeta.consecutiveErrors': 1 },
      });
    } catch (_) {}
    result.action = 'error';
    result.error  = err.message;
    return result;
  }
}

module.exports = { processEnrichmentJob };
