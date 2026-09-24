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
 * Normalizes existing amenities from various historical schema formats:
 *   - rawAmenities.raw (array)
 *   - rawAmenities (array or boolean flags map)
 *   - amenities.raw (array)
 *   - amenities (array)
 */
function extractExistingAmenities(existing = {}) {
  if (Array.isArray(existing.rawAmenities?.raw)) {
    return existing.rawAmenities.raw;
  }
  if (Array.isArray(existing.rawAmenities)) {
    return existing.rawAmenities;
  }
  if (Array.isArray(existing.amenities?.raw)) {
    return existing.amenities.raw;
  }
  if (Array.isArray(existing.amenities)) {
    return existing.amenities;
  }
  // If rawAmenities is boolean map ({ has_pool: true, ... }), reconstruct string tags
  if (existing.rawAmenities && typeof existing.rawAmenities === 'object') {
    const fromMap = [];
    if (existing.rawAmenities.has_pool) fromMap.push('Swimming pool');
    if (existing.rawAmenities.has_sauna) fromMap.push('Sauna');
    if (existing.rawAmenities.accessible) fromMap.push('Wheelchair accessible');
    if (existing.rawAmenities.free_parking) fromMap.push('Free parking');
    if (existing.rawAmenities.has_showers) fromMap.push('Showers');
    return fromMap;
  }
  return [];
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
        // NOTE: publicUrl/localPath/thumbnailUrl must be OMITTED, not null.
        // space_photos has a sparse UNIQUE index on publicUrl, and sparse
        // indexes still index explicit nulls — so after the first
        // `publicUrl: null` row every further insert hit E11000 and every
        // captured enrichment photo was silently dropped.
        $setOnInsert: {
          spaceId,
          originalUrl:  url,
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
    // ordered:false — the non-conflicting ops still landed; report them.
    if (err.code === 11000 || err.name === 'BulkWriteError' || err.name === 'MongoBulkWriteError') {
      return err.result?.upsertedCount ?? err.result?.nUpserted ?? 0;
    }
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

    // ── Freshness: rating, Google review total, closure status ───────────────
    // totalReviews mirrors Google's own count, so take it verbatim when read
    // and skip the "+newReviews" arithmetic further down.
    const googleTotal = Number.isFinite(enriched.totalReviews) && enriched.totalReviews > 0 ? enriched.totalReviews : null;
    if (Number.isFinite(enriched.rating) && enriched.rating > 0) $set.rating = enriched.rating;
    if (googleTotal) $set.totalReviews = googleTotal;
    if (enriched.permanentlyClosed && !existing.permanentlyClosed) {
      $set.permanentlyClosed = true;
      diffs.push({ field: 'permanentlyClosed', oldValue: false, newValue: true });
    }
    if (typeof enriched.temporarilyClosed === 'boolean') $set.temporarilyClosed = enriched.temporarilyClosed;

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
      const existingAmenities = extractExistingAmenities(existing);
      const merged = [...new Set([...existingAmenities, ...enriched.deepAmenities])];
      $set['amenities.raw'] = merged;
      $set['rawAmenities.raw'] = merged;
      // Sync boolean flags for backward compatibility
      $set['rawAmenities.has_pool'] = merged.some(a => a.toLowerCase().includes('pool'));
      $set['rawAmenities.has_sauna'] = merged.some(a => a.toLowerCase().includes('sauna'));
      $set['rawAmenities.accessible'] = merged.some(a => a.toLowerCase().includes('wheelchair') || a.toLowerCase().includes('accessible'));
      $set['rawAmenities.free_parking'] = merged.some(a => a.toLowerCase().includes('parking') && !a.toLowerCase().includes('paid'));
      $set['rawAmenities.has_showers'] = merged.some(a => a.toLowerCase().includes('shower') || a.toLowerCase().includes('bathroom'));

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
    const { isSocialProfileUrl } = require('./websiteScraper');
    for (const [field, newVal] of Object.entries(contactFields)) {
      if (newVal == null) continue;
      // Reject bare network homepages (e.g. https://instagram.com/) that the
      // Maps panel sometimes links to — only a real profile is worth storing.
      if (['instagram', 'facebook', 'youtube', 'whatsapp'].includes(field) && !isSocialProfileUrl(newVal)) continue;
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
    // enriched.coverPhotoUrl is the curated hero image (Google Maps' own pick,
    // or the equivalent from the source site) — a stronger "best photo" signal
    // than the arbitrary rawPhotoUrls[0] the initial crawl sets as a placeholder
    // (see upsertSpace.js). Prefer it whenever it differs from what's stored,
    // instead of leaving that placeholder in place forever.
    if (enriched.coverPhotoUrl && enriched.coverPhotoUrl !== existing.coverPhoto?.publicUrl) {
      $set['coverPhoto.publicUrl']    = enriched.coverPhotoUrl;
      // Old thumbnail/dimensions belonged to the previous publicUrl — clear
      // them so they don't get mismatched with the new image.
      $set['coverPhoto.thumbnailUrl'] = null;
      $set['coverPhoto.width']        = null;
      $set['coverPhoto.height']       = null;
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
        ...(googleTotal ? {} : { $inc: { totalReviews: newReviews } }),
        $set: { reviewsScraped: (existing.reviewsScraped || 0) + newReviews },
      });
    }
    // Report only fields whose value actually differs from what we held —
    // hours/rating/etc. are re-$set on every pass even when unchanged.
    const getPath = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
    result.changedFields = Object.keys($set)
      .filter(k => !/^(enrichmentMeta|crawl)\.|^updatedAt$|lastHoursVerifiedAt$|capturedAt$|^rawAmenities\.|^isOpenNow$/.test(k))
      .filter(k => JSON.stringify(getPath(existing, k) ?? null) !== JSON.stringify($set[k] ?? null));

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

// ─────────────────────────────────────────────────────────────────────────────
// Website source: merge scrapeWebsiteDetails() output onto a space
// ─────────────────────────────────────────────────────────────────────────────

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/**
 * Fill-only merge — a venue's own site is a weaker source than Google for
 * anything Google already gave us, so we only populate EMPTY fields and never
 * overwrite. Photos go to space_photos with sourceType 'website'.
 *
 * @param {Object}   details  output of scrapeWebsiteDetails()
 * @param {ObjectId} spaceId
 * @returns {{ action: 'enriched'|'unchanged'|'error', changedFields: string[], newPhotos: number, error?: string }}
 */
async function processWebsiteEnrichment(details, spaceId) {
  const result = { action: 'unchanged', changedFields: [], newPhotos: 0 };
  const now = new Date();
  const existing = await Space.findById(spaceId, { contact: 1, description: 1, pricing: 1, name: 1 }).lean();
  if (!existing) return { ...result, action: 'error', error: `Space not found: ${spaceId}` };

  const c = existing.contact || {};
  const $set = {};
  const fill = (field, value) => {
    if (value && !c[field]) $set[`contact.${field}`] = value;
  };

  fill('email', details.emails?.[0]);
  const altPhone = (details.phones || []).find(p => last10(p) && last10(p) !== last10(c.phone));
  if (!c.phone && details.phones?.[0]) $set['contact.phone'] = details.phones[0];
  else fill('phone2', altPhone);
  for (const key of ['instagram', 'facebook', 'youtube', 'whatsapp']) fill(key, details.socials?.[key]);
  fill('bookingUrl', details.bookingUrl);

  if (!existing.description && details.description && details.description.length >= 40) {
    $set.description = details.description.slice(0, 1000);
  }
  if (!existing.pricing?.rawText && details.jsonLd?.priceRange) {
    $set['pricing.rawText']    = details.jsonLd.priceRange;
    $set['pricing.source']     = 'website';
    $set['pricing.capturedAt'] = now;
  }
  if (details.jsonLd?.openingHours?.length) {
    $set['operationalData.websiteHours'] = details.jsonLd.openingHours.slice(0, 14);
  }

  result.changedFields = Object.keys($set);
  if (result.changedFields.length) {
    await Space.updateOne({ _id: spaceId }, { $set }, { timestamps: true });
    await writeChangeLogs(spaceId, result.changedFields
      .filter(f => f.startsWith('contact.') || f === 'description')
      .map(f => ({ field: f, oldValue: null, newValue: $set[f] })), now);
    result.action = 'enriched';
  }

  result.newPhotos = await upsertCapturedPhotoUrls(spaceId, details.photos || [], 'website', now);
  if (result.newPhotos && result.action === 'unchanged') result.action = 'enriched';

  logger.info(`[ENRICH:web] "${existing.name}" → ${result.action} (${result.changedFields.join(', ') || 'no new fields'}, +${result.newPhotos} photos)`);
  return result;
}

/**
 * The listed "website" is a social profile — file it under the matching
 * contact field (if empty) instead of browsing into a login wall.
 */
async function recordSocialWebsite(spaceId, network, url) {
  const field = ['instagram', 'facebook', 'youtube', 'whatsapp'].includes(network) ? network : null;
  if (!field) return false;
  const res = await Space.updateOne(
    { _id: spaceId, $or: [{ [`contact.${field}`]: { $exists: false } }, { [`contact.${field}`]: null }, { [`contact.${field}`]: '' }] },
    { $set: { [`contact.${field}`]: url } }
  );
  return res.modifiedCount > 0;
}

module.exports = { processEnrichmentJob, processWebsiteEnrichment, recordSocialWebsite };
