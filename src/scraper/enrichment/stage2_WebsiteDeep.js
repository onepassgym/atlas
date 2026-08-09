'use strict';
/**
 * Stage 2 — Official Website Deep Scrape
 * Visits the gym's official website to extract:
 * - JSON-LD structured data (LocalBusiness schema)
 * - Pricing information
 * - Class schedule
 * - Amenities from body text
 * - Photos from gallery
 */

const websiteSource = require('../sources/OfficialWebsiteSource');

async function runStage2(space) {
  const url = space.contact?.website;
  if (!url) return {};

  try {
    const webData = await websiteSource.scrapeByUrl(url);
    if (!webData) return {};

    const updates = {};

    // Only update fields where we have better data from website
    if (!space.description && webData.description)
      updates.description = webData.description;

    if (!space.priceLevel && webData.priceLevel)
      updates.priceLevel = webData.priceLevel;

    if (webData.amenities?.raw?.length > 0) {
      const existingRaw = space.amenitySlugs || [];
      const newRaw = webData.amenities.raw.filter(a => !existingRaw.includes(a));
      if (newRaw.length > 0) updates._newAmenityRaw = newRaw;
    }

    if (webData.offerings?.length > 0) {
      updates.offerings = [...new Set([...(space.offerings || []), ...webData.offerings])];
    }

    if (webData.hasClasses) updates.hasClasses = true;

    // Merge new photo URLs
    if (webData.rawPhotoUrls?.length > 0) {
      const existing = new Set(space.rawPhotoUrls || []);
      const newPhotos = webData.rawPhotoUrls.filter(u => !existing.has(u));
      if (newPhotos.length) updates._newPhotoUrls = newPhotos;
    }

    // Merge hours if we don't have them or website has more
    if (webData.openingHours?.length > (space.openingHours?.length || 0)) {
      updates.openingHours = webData.openingHours;
    }

    updates._stageData = { url, amenitiesFound: webData.amenities?.raw?.length || 0 };
    return updates;

  } catch (err) {
    return { _stageError: err.message };
  }
}

module.exports = { runStage2 };
