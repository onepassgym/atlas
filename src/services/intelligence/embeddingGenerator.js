'use strict';
/**
 * embeddingGenerator.js — Generates embedText for Typesense semantic index.
 * Uses LLM to produce a rich, search-optimized text representation.
 */

const llm = require('./llmClient');

async function generateEmbedText(space, stageUpdates = {}) {
  // Build embedding text directly (no LLM needed — deterministic concatenation is better for embeddings)
  const name        = space.name || '';
  const city        = space.city || space.areaName || '';
  const category    = (stageUpdates._llmCategories || space.categorySlugs || []).map(s => s.replace(/-/g, ' ')).join(' ');
  const amenities   = (stageUpdates.amenitySlugs || space.amenitySlugs || []).map(s => s.replace(/-/g, ' ')).join(' ');
  const description = stageUpdates.description || space.description || '';
  const tags        = (space.tags || []).join(' ');
  const offerings   = (stageUpdates.offerings || space.offerings || []).join(' ');

  const embedText = [name, city, category, amenities, description.slice(0, 300), tags, offerings]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 2000);

  return { embedText, cost: 0 }; // No LLM cost — pure text concatenation
}

module.exports = { generateEmbedText };
