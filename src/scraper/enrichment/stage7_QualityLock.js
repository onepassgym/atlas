'use strict';
/**
 * Stage 7 — Quality Lock
 * Recomputes quality/completeness scores, locks enrichment as done,
 * and schedules the next re-enrichment date based on quality tier.
 * Also performs chain detection if not already tagged.
 */

const { calculateQualityScore } = require('../../services/intelligence/scoring');
const SpaceChain = require('../../db/gymChainModel');

// Re-enrichment schedule by quality tier
const REENRICH_DAYS = {
  high:   90, // qualityScore >= 80
  mid:    60, // qualityScore 50–79
  low:    30, // qualityScore < 50
};

function calcCompleteness(space) {
  const checks = [
    space.name,
    space.location?.coordinates,
    space.address,
    space.contact?.phone,
    space.contact?.website,
    space.rating,
    space.totalReviews > 0,
    (space.openingHours?.length || 0) > 0,
    (space.rawPhotoUrls?.length || 0) > 0 || space.coverUrl,
    space.description,
    space.primaryCategorySlug,
    (space.amenitySlugs?.length || 0) > 0,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((filled / checks.length) * 100);
}

/**
 * Detect chain membership by matching the space name against known chain patterns.
 * Returns { chainSlug, chainOpgId, chainName } or null.
 */
async function detectChain(spaceName) {
  if (!spaceName) return null;
  const chains = await SpaceChain.find({ isActive: true }, { name: 1, aliases: 1, slug: 1, opgId: 1 }).lean();
  const lower = spaceName.toLowerCase();
  for (const chain of chains) {
    const names = [chain.name, ...(chain.aliases || [])];
    if (names.some(n => lower.includes(n.toLowerCase()))) {
      return { chainSlug: chain.slug, chainOpgId: chain.opgId, chainName: chain.name };
    }
  }
  return null;
}

async function runStage7(space) {
  const qScore = calculateQualityScore({
    ...space,
    crawlMeta: { lastCrawledAt: new Date() },
  });

  const completeness = calcCompleteness(space);

  // Determine next enrichment date
  let tier = 'low';
  if (qScore.score >= 80) tier = 'high';
  else if (qScore.score >= 50) tier = 'mid';

  const nextEnrichAt = new Date(Date.now() + REENRICH_DAYS[tier] * 86_400_000);

  const result = {
    qualityScore:     qScore.score,
    scoreBreakdown:   qScore.breakdown,
    dataCompleteness: completeness,
    'enrichment.nextEnrichAt': nextEnrichAt,
    _stageData: {
      qualityScore: qScore.score,
      completeness,
      tier,
      nextEnrichAt: nextEnrichAt.toISOString(),
      reEnrichInDays: REENRICH_DAYS[tier],
    },
  };

  // Detect chain membership if not already tagged
  if (!space.chainOpgId) {
    try {
      const chain = await detectChain(space.name);
      if (chain) {
        result.chainOpgId  = chain.chainOpgId;
        result.chainSlug   = chain.chainSlug;
        result.isChainMember = true;
        result._stageData.chainDetected = chain.chainName;
      }
    } catch (_) {}
  }

  return result;
}

module.exports = { runStage7 };
