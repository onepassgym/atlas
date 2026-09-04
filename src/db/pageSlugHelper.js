'use strict';
const PageSlug = require('./pageSlugModel');

async function ensureUniquePageSlug(baseSlug, spaceId, opgId, name, address, categoryName) {
  let currentSlug = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await PageSlug.findOne({ slug: currentSlug }).lean();
    
    // If no one has this slug, it's ours!
    if (!existing) {
      break;
    }
    
    // If it exists and already points to our space, we can reuse it
    if (existing.spaceId.toString() === spaceId.toString()) {
      return currentSlug;
    }

    // Otherwise, collision! Append a counter.
    // E.g. "anytime-fitness-mumbai-2"
    counter++;
    currentSlug = `${baseSlug}-${counter}`;
  }

  // Pre-populate some sensible SEO defaults for pageData
  const defaultPageData = {
    seoTitle: `${name || 'Space'} - ${categoryName || 'Venue'} in ${address ? address.split(',')[0] : 'your area'}`,
    metaDescription: `Check out ${name} located in ${address || 'your area'}. View photos, reviews, and amenities.`,
    displayTitle: name
  };

  // Upsert the slug (in case of race conditions, upsert handles it gracefully)
  await PageSlug.updateOne(
    { slug: currentSlug },
    { 
      $set: { spaceId, opgId, isActive: true },
      $setOnInsert: { pageData: defaultPageData }
    },
    { upsert: true }
  );

  return currentSlug;
}

module.exports = { ensureUniquePageSlug };
