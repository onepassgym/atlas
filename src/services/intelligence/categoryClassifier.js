'use strict';
/**
 * categoryClassifier.js — LLM-powered category classification.
 */

const llm = require('./llmClient');
const { CATEGORIES } = require('../../../migration/seedStaticData');

const VALID_SLUGS = CATEGORIES.map(c => c.slug);

const SYSTEM = `You are a fitness venue classifier. Given a gym's name, description, and reviews, classify it into the most appropriate categories from the provided list. Return ONLY a JSON object.`;

async function classifyCategories(space, reviewText = '') {
  const user = `
Gym name: ${space.name || ''}
Description: ${(space.description || '').slice(0, 300)}
Current categories: ${(space.categorySlugs || []).join(', ')}
Review excerpt: ${reviewText.slice(0, 500)}

Valid category slugs:
${VALID_SLUGS.join(', ')}

Return JSON: {"primaryCategorySlug": "slug", "categorySlugs": ["slug1", "slug2"]}
Rules:
- primaryCategorySlug must be ONE slug from the list
- categorySlugs must be 1-4 slugs from the list
- Prefer specific categories (e.g. "yoga-studio" over "gym" for a yoga venue)`;

  const { result, cost } = await llm.call({ system: SYSTEM, user, maxTokens: 150 });

  const primary = VALID_SLUGS.includes(result?.primaryCategorySlug) ? result.primaryCategorySlug : null;
  const cats    = (result?.categorySlugs || []).filter(s => VALID_SLUGS.includes(s));

  return { primaryCategorySlug: primary, categorySlugs: cats, cost };
}

module.exports = { classifyCategories };
