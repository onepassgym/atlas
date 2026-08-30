'use strict';

/**
 * Calculates a composite 0-100 quality score for a space.
 * @param {Object} spaceData - The crawled data or space document.
 * @returns {{ score: number, breakdown: Object }}
 */
function calculateQualityScore(spaceData) {
  let score = 0;
  const breakdown = {
    rating: 0,
    reviews: 0,
    completeness: 0,
    media: 0,
    freshness: 0
  };

  // 1. Rating (Max 40 points)
  if (spaceData.rating > 0) {
    breakdown.rating = Math.round((spaceData.rating / 5) * 40);
  }

  // 2. Reviews (Max 20 points, logarithmic scaling, maxed at ~500 reviews)
  const totalReviews = spaceData.totalReviews || 0;
  if (totalReviews > 0) {
    let revScore = (Math.log(totalReviews + 1) / Math.log(500)) * 20;
    breakdown.reviews = Math.round(Math.min(revScore, 20));
  }

  // 3. Completeness (Max 20 points, 12 checks)
  const checks = [
    spaceData.name,
    spaceData.lat,
    spaceData.lng,
    spaceData.address,
    spaceData.contact?.phone,
    spaceData.contact?.website,
    spaceData.rating,
    spaceData.totalReviews,
    spaceData.openingHours?.length > 0,
    (spaceData.photos?.length || spaceData.totalPhotos > 0),
    spaceData.description,
    spaceData.category || spaceData.categoryId
  ];
  const filled = checks.filter(Boolean).length;
  breakdown.completeness = Math.round((filled / checks.length) * 20);

  // 4. Media Richness (Max 10 points - 2 pts per photo max 5, + bonus for high visual appeal)
  const photoCount = spaceData.photos?.length || spaceData.totalPhotos || 0;
  let mediaScore = Math.min(photoCount * 2, 10);
  if (spaceData.visualAppealScore > 80) mediaScore += 2; // small bonus for great photos
  else if (spaceData.visualAppealScore < 40 && photoCount > 0) mediaScore -= 2; // penalty for bad photos
  breakdown.media = Math.max(0, Math.min(mediaScore, 10));

  // 5. Freshness (Max 10 points) - Assumes if being crawled, it's fresh right now.
  // We can refine this if we run the scorer asynchronously, but for upsert, it's 10.
  // Let's check `lastCrawledAt` from metadata if it exists.
  const lastCrawledAt = spaceData.crawlMeta?.lastCrawledAt || new Date();
  const daysSince = (new Date() - new Date(lastCrawledAt)) / (1000 * 60 * 60 * 24);
  
  if (daysSince <= 30) breakdown.freshness = 10;
  else if (daysSince <= 90) breakdown.freshness = 5;
  else breakdown.freshness = 0;

  score = breakdown.rating + breakdown.reviews + breakdown.completeness + breakdown.media + breakdown.freshness;

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown
  };
}

module.exports = { calculateQualityScore };
