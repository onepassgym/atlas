'use strict';
/**
 * amenityExtractor.js — LLM-powered amenity extraction from review text.
 * Replaces keyword-regex approach with structured LLM output.
 */

const llm = require('./llmClient');
const { AMENITIES } = require('../../../migration/seedStaticData');

const AMENITY_SLUGS = AMENITIES.map(a => a.slug);

const SYSTEM = `You are a fitness data extraction assistant. Given gym reviews, extract amenities that are explicitly or implicitly mentioned. Return ONLY a JSON object with key "amenitySlugs" as an array of slugs from the provided list.`;

async function extractAmenities(space, reviewText) {
  const user = `
Gym: ${space.name || 'Unknown'}
Category: ${space.primaryCategorySlug || ''}

Review text:
${reviewText.slice(0, 3000)}

Available amenity slugs (only return slugs from THIS list):
${AMENITY_SLUGS.join(', ')}

Return JSON: {"amenitySlugs": ["slug1", "slug2", ...]}`;

  const { result, cost } = await llm.call({ system: SYSTEM, user, maxTokens: 200 });

  const slugs = (result?.amenitySlugs || []).filter(s => AMENITY_SLUGS.includes(s));
  return { amenitySlugs: slugs, cost };
}

module.exports = { extractAmenities };
