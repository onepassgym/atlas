'use strict';
/**
 * Stage 6 — AI Intelligence
 * LLM-powered analysis pass. Runs only when AI is enabled.
 * Tasks (in cost order, cheapest first):
 *   A. Amenity extraction from review text (gpt-4o-mini)
 *   B. Category classification (gpt-4o-mini)
 *   C. Sentiment analysis — replaces keyword approach (gpt-4o-mini)
 *   D. Description generation (gpt-4o-mini)
 *   E. embedText generation for Typesense semantic index (gpt-4o-mini)
 *   F. Data validation — catch bad fields (gpt-4o-mini)
 */

const llm = require('../../services/intelligence/llmClient');
const { extractAmenities }     = require('../../services/intelligence/amenityExtractor');
const { classifyCategories }   = require('../../services/intelligence/categoryClassifier');
const { generateDescription }  = require('../../services/intelligence/descriptionGenerator');
const { generateEmbedText }    = require('../../services/intelligence/embeddingGenerator');
const { analyzeGymSentimentAI }= require('../../services/intelligence/sentiment');
const cfg = require('../../../config');

async function runStage6(space) {
  if (!cfg.ai?.enabled) return { _stageData: { skipped: 'AI disabled' } };

  const updates = {};
  let totalCost = 0;
  const maxCost = cfg.ai.maxCostPerSpace || 0.05;

  // Build review text corpus (last 50 reviews, max 8000 chars)
  const reviewTexts = (space._reviews || [])
    .slice(-50)
    .map(r => r.text)
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);

  // Task A: Amenity extraction
  if (totalCost < maxCost && reviewTexts.length > 100) {
    try {
      const { amenitySlugs, cost } = await extractAmenities(space, reviewTexts);
      if (amenitySlugs.length > 0) updates._llmAmenitySlugs = amenitySlugs;
      totalCost += cost || 0;
    } catch (_) {}
  }

  // Task B: Category classification
  if (totalCost < maxCost) {
    try {
      const { primaryCategorySlug, categorySlugs, cost } = await classifyCategories(space, reviewTexts);
      if (primaryCategorySlug) updates._llmPrimaryCategory = primaryCategorySlug;
      if (categorySlugs?.length) updates._llmCategories = categorySlugs;
      totalCost += cost || 0;
    } catch (_) {}
  }

  // Task C: Sentiment analysis
  if (totalCost < maxCost && reviewTexts.length > 200) {
    try {
      const { score, tags, cost } = await analyzeGymSentimentAI(reviewTexts);
      updates.sentimentScore = score;
      updates.sentimentTags  = tags;
      totalCost += cost || 0;
    } catch (_) {}
  }

  // Task D: Description generation
  if (totalCost < maxCost && !space.description) {
    try {
      const { description, cost } = await generateDescription(space);
      if (description) updates.description = description;
      totalCost += cost || 0;
    } catch (_) {}
  }

  // Task E: embedText for semantic search
  if (totalCost < maxCost) {
    try {
      const { embedText, cost } = await generateEmbedText(space, updates);
      if (embedText) updates.embedText = embedText;
      totalCost += cost || 0;
    } catch (_) {}
  }

  updates._stageData = { aiCost: totalCost, tasksRun: Object.keys(updates).filter(k => !k.startsWith('_stageData')).length };
  return updates;
}

module.exports = { runStage6 };
