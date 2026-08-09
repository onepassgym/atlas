'use strict';
/**
 * descriptionGenerator.js — LLM-powered gym description generation.
 */

const llm = require('./llmClient');

const SYSTEM = `You are a fitness copywriter. Write a concise 2-3 sentence description of a gym based on the provided data. Be factual, specific, and helpful. No marketing fluff. No invented claims.`;

async function generateDescription(space) {
  if (space.description && space.description.length > 80) {
    return { description: null, cost: 0 }; // already has good description
  }

  const amenities = (space.amenitySlugs || []).slice(0, 8).map(s => s.replace(/-/g, ' ')).join(', ');
  const categories = (space.categorySlugs || []).map(s => s.replace(/-/g, ' ')).join(', ');

  const user = `
Name: ${space.name || 'Fitness Center'}
Location: ${[space.areaName, space.city].filter(Boolean).join(', ')}
Category: ${categories || space.primaryCategorySlug || 'gym'}
Rating: ${space.rating || 'N/A'} (${space.totalReviews || 0} reviews)
Amenities: ${amenities || 'N/A'}
Price level: ${space.priceLevel || 'N/A'}

Write a factual 2-3 sentence description. Return JSON: {"description": "..."}`;

  const { result, cost } = await llm.call({ system: SYSTEM, user, maxTokens: 150 });
  return { description: result?.description || null, cost };
}

module.exports = { generateDescription };
