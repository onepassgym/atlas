'use strict';
/**
 * EnrichmentGraphService — 7-stage DAG enrichment loop.
 *
 * Picks spaces with incomplete enrichment stages (stage 0–6) and advances
 * them one stage at a time. Continuously loops: the system never stops
 * improving its own data.
 *
 * Stage pipeline:
 *   0 → Base crawl complete (set by worker.js after initial scrape)
 *   1 → Multi-source cross-reference
 *   2 → Official website deep scrape
 *   3 → Social signals (Google Search, Facebook)
 *   4 → Review mining (deep multi-source)
 *   5 → Media harvest & photo classification
 *   6 → AI intelligence (amenities, categories, description, embedText)
 *   7 → Quality lock (scores finalized, next re-enrich scheduled)
 */

const Space         = require('../db/spaceModel');
const Review        = require('../db/reviewModel');
const Photo         = require('../db/photoModel');
const EnrichmentLog = require('../db/enrichmentLogModel');
const { makeOpgId } = require('../utils/opgId');
const logger        = require('../utils/logger');
const bus           = require('./eventBus');

const { runStage1 } = require('../scraper/enrichment/stage1_MultiSource');
const { runStage2 } = require('../scraper/enrichment/stage2_WebsiteDeep');
const { runStage3 } = require('../scraper/enrichment/stage3_SocialSignals');
const { runStage4 } = require('../scraper/enrichment/stage4_ReviewMining');
const { runStage5 } = require('../scraper/enrichment/stage5_MediaHarvest');
const { runStage6 } = require('../scraper/enrichment/stage6_AIIntelligence');
const { runStage7 } = require('../scraper/enrichment/stage7_QualityLock');

const STAGE_RUNNERS = [null, runStage1, runStage2, runStage3, runStage4, runStage5, runStage6, runStage7];

/**
 * Advance a space by exactly ONE stage.
 * @param {string} spaceOpgId — the space's opgId
 * @returns {{ stage, action, stageData, durationMs }}
 */
async function advanceStage(spaceOpgId) {
  const startTime = Date.now();
  const space = await Space.findOne({ opgId: spaceOpgId }).lean();
  if (!space) throw new Error(`Space not found: ${spaceOpgId}`);

  const currentStage = space.enrichment?.stage ?? 0;
  const targetStage  = currentStage + 1;

  if (targetStage > 7) {
    return { stage: 7, action: 'already_complete', durationMs: 0 };
  }

  const runner = STAGE_RUNNERS[targetStage];
  if (!runner) throw new Error(`No runner for stage ${targetStage}`);

  logger.info(`[EnrichGraph] ${spaceOpgId} stage ${currentStage}→${targetStage} (${space.name || '?'})`);
  bus.publish('enrichment:stage-start', { spaceOpgId, name: space.name, stage: targetStage });

  let stageData = {};
  let stageError = null;

  try {
    // Load full reviews for AI stage
    if (targetStage === 6) {
      const reviews = await Review.find({ spaceOpgId }, { text: 1, rating: 1, _id: 0 }).lean();
      space._reviews = reviews;
    }

    stageData = await runner(space);
  } catch (err) {
    stageError = err.message;
    logger.warn(`[EnrichGraph] Stage ${targetStage} failed for ${spaceOpgId}: ${err.message}`);
  }

  const durationMs = Date.now() - startTime;

  // Build MongoDB update
  const $set = {
    'enrichment.lastAttempt': new Date(),
    [`enrichment.stageCompletedAt.${targetStage - 1}`]: new Date(),
    [`enrichment.stageErrors.${targetStage - 1}`]: stageError,
  };
  const $inc = {};

  if (!stageError) {
    $set['enrichment.stage']       = targetStage;
    $set['enrichment.lastSuccess'] = new Date();
    $set['enrichment.consecutiveErrors'] = 0;
    $set['enrichment.status'] = targetStage === 7 ? 'success' : 'never';

    // Apply stage-specific field updates
    await _applyStageUpdates(space, stageData, $set);

    if (targetStage === 7) {
      $set['enrichment.nextEnrichAt'] = stageData['enrichment.nextEnrichAt'];
      $set.qualityScore     = stageData.qualityScore;
      $set.scoreBreakdown   = stageData.scoreBreakdown;
      $set.dataCompleteness = stageData.dataCompleteness;
      // Chain detection result from Stage 7
      if (stageData.chainOpgId)    $set.chainOpgId    = stageData.chainOpgId;
      if (stageData.chainSlug)     $set.chainSlug     = stageData.chainSlug;
      if (stageData.isChainMember) $set.isChainMember = true;
    }
  } else {
    $inc['enrichment.consecutiveErrors'] = 1;
    $set['enrichment.error'] = stageError;
    // Still advance stage (skip broken stage) to prevent infinite loop on one broken space
    // But only if we've seen 2+ consecutive errors on this stage
    const consec = (space.enrichment?.consecutiveErrors || 0) + 1;
    if (consec >= 2) {
      $set['enrichment.stage'] = targetStage; // skip past broken stage
      logger.warn(`[EnrichGraph] Skipping stage ${targetStage} for ${spaceOpgId} after ${consec} errors`);
    }
  }

  await Space.updateOne({ opgId: spaceOpgId }, { $set, ...(Object.keys($inc).length ? { $inc } : {}) });

  // Write enrichment log entry
  await EnrichmentLog.create({
    spaceOpgId,
    spaceId:      space._id,
    status:       stageError ? 'failed' : 'success',
    stage:        targetStage,
    durationMs,
    error:        stageError,
    fieldsUpdated: Object.keys($set).filter(k => !k.startsWith('enrichment.')),
    reviewsAdded: stageData._newReviews?.length || 0,
    photosAdded:  stageData._newPhotoUrls?.length || 0,
  }).catch(() => {});

  bus.publish('enrichment:stage-done', {
    spaceOpgId,
    name:   space.name,
    stage:  targetStage,
    error:  stageError,
    durationMs,
  });

  return { stage: targetStage, action: stageError ? 'error' : 'advanced', stageData: stageData._stageData, durationMs };
}

/**
 * Find the next space that needs enrichment.
 * Priority: (1) Redis priority queue, (2) lowest stage, (3) oldest updatedAt.
 */
async function getNextSpace(prioritySpaceOpgId = null) {
  if (prioritySpaceOpgId) {
    const space = await Space.findOne({ opgId: prioritySpaceOpgId }, { opgId: 1, name: 1, 'enrichment.stage': 1 }).lean();
    if (space) return space;
  }

  // Find spaces not yet at stage 7, sorted by stage ASC then updatedAt ASC
  const space = await Space.findOne(
    {
      'enrichment.stage': { $lt: 7 },
      'enrichment.consecutiveErrors': { $lt: 5 }, // skip quarantined spaces
      'enrichment.status': { $ne: 'quarantined' },
      deletedAt: null,
      $or: [
        { 'enrichment.nextEnrichAt': { $lte: new Date() } },
        { 'enrichment.nextEnrichAt': null },
        { 'enrichment.nextEnrichAt': { $exists: false } },
      ],
    },
    { opgId: 1, name: 1, 'enrichment.stage': 1 }
  )
    .sort({ 'enrichment.stage': 1, updatedAt: 1 })
    .lean();

  return space || null;
}

// ── Internal: apply stage-specific field updates to $set ─────────────────────

async function _applyStageUpdates(space, stageData, $set) {
  const spaceOpgId = space.opgId;

  // Sources (Stage 1)
  if (stageData.sources) {
    $set.sources = stageData.sources;
  }
  // fieldConfidence from Stage 1 mergeWithConfidence() — used by quality scoring
  if (stageData.fieldConfidence && Object.keys(stageData.fieldConfidence).length > 0) {
    for (const [field, fcEntry] of Object.entries(stageData.fieldConfidence)) {
      $set[`fieldConfidence.${field}`] = fcEntry;
    }
  }
  if (stageData.contact) _mergeContact($set, stageData.contact);
  if (stageData.description) $set.description = stageData.description;
  if (stageData.priceLevel)  $set.priceLevel  = stageData.priceLevel;
  if (stageData.openingHours?.length) $set.openingHours = stageData.openingHours;
  if (stageData.offerings)   $set.offerings   = stageData.offerings;
  if (stageData.hasClasses)  $set.hasClasses  = true;

  // Amenities from Stage 2 (raw labels) + Stage 6 (LLM slugs)
  if (stageData._newAmenityRaw?.length || stageData._llmAmenitySlugs?.length) {
    const current  = new Set(space.amenitySlugs || []);
    const newSlugs = [...(stageData._llmAmenitySlugs || []), ...(stageData._newAmenityRaw || []).map(s => s.toLowerCase().replace(/\s+/g, '-'))];
    newSlugs.forEach(s => current.add(s));
    $set.amenitySlugs = [...current];
  }

  // Categories from Stage 6
  if (stageData._llmPrimaryCategory) $set.primaryCategorySlug = stageData._llmPrimaryCategory;
  if (stageData._llmCategories?.length) {
    const current = new Set(space.categorySlugs || []);
    stageData._llmCategories.forEach(c => current.add(c));
    $set.categorySlugs = [...current];
  }

  // Sentiment (Stage 6)
  if (stageData.sentimentScore != null) $set.sentimentScore = stageData.sentimentScore;
  if (stageData.sentimentTags)          $set.sentimentTags  = stageData.sentimentTags;

  // embedText (Stage 6)
  if (stageData.embedText) $set.embedText = stageData.embedText;

  // Photos (Stage 5 + others)
  if (stageData.rawPhotoUrls?.length) {
    const existing = new Set(space.rawPhotoUrls || []);
    const newUrls  = stageData.rawPhotoUrls.filter(u => !existing.has(u));
    if (newUrls.length) {
      $set.rawPhotoUrls = [...existing, ...newUrls];
      $set.totalPhotos  = $set.rawPhotoUrls.length;
    }
  }
  if (stageData.coverUrl) $set.coverUrl = stageData.coverUrl;
  if (stageData.totalPhotos) $set.totalPhotos = stageData.totalPhotos;

  // Save typed photo records to space_photos collection
  if (stageData._typedPhotos?.length) {
    const spaceId = space._id;
    const ops = stageData._typedPhotos.map((p, idx) => ({
      updateOne: {
        filter: { originalUrl: p.url, spaceId },
        update: {
          $setOnInsert: {
            opgId:      makeOpgId('photo'),
            spaceId,
            spaceOpgId,
            originalUrl: p.url,
            publicUrl:   p.url,
            type:        p.type,
            order:       p.order,
            isCover:     idx === 0,
            downloaded:  false,
            sourceType:  'general',
            createdVia:  'enrichment',
            createdAt:   new Date(),
          }
        },
        upsert: true,
      }
    }));
    if (ops.length) {
      const PhotoModel = require('../db/photoModel');
      await PhotoModel.bulkWrite(ops, { ordered: false }).catch(() => {});
    }
  }

  // Reviews (Stage 4)
  if (stageData._newReviews?.length) {
    const ReviewModel = require('../db/reviewModel');
    const { buildReviewDocs } = ReviewModel;
    if (typeof buildReviewDocs === 'function') {
      const docs = buildReviewDocs(space._id, stageData._newReviews, spaceOpgId);
      docs.forEach(d => { d.opgId = makeOpgId('review'); });
      await ReviewModel.Review.insertMany(docs, { ordered: false }).catch(() => {});
    }
  }

  // Social contacts (Stage 3)
  if (stageData['contact.instagram']) $set['contact.instagram'] = stageData['contact.instagram'];
  if (stageData['contact.facebook'])  $set['contact.facebook']  = stageData['contact.facebook'];
  if (stageData['contact.website'] && !space.contact?.website)
    $set['contact.website'] = stageData['contact.website'];
  if (stageData._newPhotoUrls?.length) {
    const existing = new Set(space.rawPhotoUrls || []);
    const fresh    = stageData._newPhotoUrls.filter(u => !existing.has(u));
    if (fresh.length) {
      const merged = [...existing, ...fresh];
      $set.rawPhotoUrls = merged;
      $set.totalPhotos  = merged.length;
    }
  }
}

function _mergeContact($set, contact) {
  for (const [k, v] of Object.entries(contact)) {
    if (v) $set[`contact.${k}`] = v;
  }
}

module.exports = { advanceStage, getNextSpace };
