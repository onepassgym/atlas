'use strict';
/**
 * Stage 5 — Media Harvest
 * Collects photo URLs from all sources, runs vision analysis,
 * selects best cover photo.
 */

const { analyzePhotoAppeal } = require('../../services/intelligence/photoVision');
const logger = require('../../utils/logger');

async function runStage5(space) {
  const allUrls = new Set(space.rawPhotoUrls || []);

  // Collect from Google Maps (source URL already scraped in prior stages)
  // Additional photo URLs may have been added by Stage 1/2 cross-ref — already in rawPhotoUrls

  const allUrlsArr = [...allUrls].filter(Boolean);
  if (!allUrlsArr.length) return { _stageData: { totalPhotos: 0 } };

  // Attempt vision analysis on first 10 photos to identify cover candidates
  const analyzed = [];
  for (const url of allUrlsArr.slice(0, 10)) {
    try {
      const appeal = await analyzePhotoAppeal(url);
      analyzed.push({ url, ...appeal });
    } catch (_) {
      analyzed.push({ url, score: 50, tags: [] }); // neutral fallback
    }
  }

  // Sort by appeal score — best first
  analyzed.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Categorize photos by tag keywords
  const typed = allUrlsArr.map((url, idx) => {
    const analysis = analyzed.find(a => a.url === url);
    const tags     = analysis?.tags || [];
    let type = 'general';
    if (idx === 0 || tags.includes('cover'))     type = 'cover';
    else if (tags.includes('exterior'))          type = 'exterior';
    else if (tags.includes('pool'))              type = 'equipment';
    else if (tags.some(t => /equipment|machine|weight/.test(t))) type = 'equipment';
    else if (tags.some(t => /interior|inside/.test(t)))          type = 'interior';
    return { url, type, order: idx, appealScore: analysis?.score || 50 };
  });

  const bestCover = analyzed[0]?.url || allUrlsArr[0];

  return {
    rawPhotoUrls: allUrlsArr,
    coverUrl:     bestCover,
    totalPhotos:  allUrlsArr.length,
    _typedPhotos: typed,
    _stageData:   { totalPhotos: allUrlsArr.length, analyzed: analyzed.length },
  };
}

module.exports = { runStage5 };
