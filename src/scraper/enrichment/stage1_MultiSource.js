'use strict';
/**
 * Stage 1 — Multi-Source Cross-Reference
 * For spaces that only have one source, fan-out to all other sources
 * to find additional data (contact, hours, reviews, amenities).
 */

const registry = require('../SourceRegistry');
const resolver = require('../SpaceResolver');
const logger   = require('../../utils/logger');

async function runStage1(space) {
  if (!space.name) return { _stageData: { skipped: 'no name' } };

  // Skip cross-ref if already well-sourced (3+ independent sources)
  const existingSources = space.sources || [];
  if (existingSources.length >= 3) {
    return { _stageData: { skipped: 'already multi-sourced', sourceCount: existingSources.length } };
  }

  const location = space.city || space.areaName;
  let rawResults = [];
  try {
    rawResults = await registry.searchByName(space.name, location);
  } catch (err) {
    logger.warn(`[stage1] searchByName failed for "${space.name}": ${err.message}`);
    return { _stageData: { error: err.message } };
  }

  // Filter out sources already represented
  const newResults = rawResults.filter(r => !existingSources.includes(r.sourceId));
  if (!newResults.length) {
    return { _stageData: { resultCount: 0, sourcesChecked: rawResults.length } };
  }

  // Add the existing space data as a pseudo-result for merging
  const existingResult = {
    sourceId:     existingSources[0] || 'google_maps',
    name:         space.name,
    lat:          space.location?.coordinates?.[1],
    lng:          space.location?.coordinates?.[0],
    address:      space.address,
    city:         space.city,
    areaName:     space.areaName,
    contact:      space.contact || {},
    rating:       space.rating,
    totalReviews: space.totalReviews,
    description:  space.description,
    openingHours: space.openingHours || [],
    categories:   space.categorySlugs || [],
    amenities:    { raw: space.amenitySlugs || [] },
    photos:       space.rawPhotoUrls || [],
    reviews:      [],
  };

  const { merged, fieldConfidence } = resolver.mergeWithConfidence([existingResult, ...newResults]);
  const newSources = [...new Set([...existingSources, ...newResults.map(r => r.sourceId)])];

  return {
    sources:        newSources,
    contact:        merged.contact,
    openingHours:   merged.openingHours?.length > (space.openingHours?.length || 0) ? merged.openingHours : undefined,
    description:    !space.description && merged.description ? merged.description : undefined,
    amenities:      merged.amenities,
    rawPhotoUrls:   merged.rawPhotoUrls?.length > (space.rawPhotoUrls?.length || 0) ? merged.rawPhotoUrls : undefined,
    fieldConfidence,
    _stageData:     { newSources: newResults.map(r => r.sourceId), resultCount: newResults.length },
  };
}

module.exports = { runStage1 };
