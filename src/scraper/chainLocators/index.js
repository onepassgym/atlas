'use strict';
/**
 * Chain Locator Registry
 *
 * Maps chain slugs to their store-locator scraper modules.
 * Each module exports:
 *   - fetchAllLocations()  → Promise<Array<NormalizedLocation>>
 *   - chainSlug            → string
 *
 * NormalizedLocation shape:
 *   { name, address, city, state, country, countryCode, postalCode,
 *     lat, lng, phone, website, hours, storeId }
 */

const logger = require('../../utils/logger');

// ── Lazy-load registry (avoids breaking startup if one module has issues) ─────

const LOCATOR_MAP = {
  'anytime-fitness': './anytimeFitness',
  'golds-gym':       './goldsGym',
  'planet-fitness':  './planetFitness',
  'snap-fitness':    './snapFitness',
  'f45-training':    './f45Training',
  'cult-fit':        './cultFit',
  'orangetheory':    './orangetheory',
};

/**
 * Get a locator module for the given chain slug.
 * Falls back to the OSM Overpass fallback if no dedicated locator exists.
 */
function getLocator(chainSlug) {
  const modulePath = LOCATOR_MAP[chainSlug];
  if (modulePath) {
    try {
      return require(modulePath);
    } catch (err) {
      logger.warn(`[ChainLocator] Failed to load locator for "${chainSlug}": ${err.message}. Falling back to OSM.`);
    }
  }
  return require('./osmFallback');
}

/**
 * List all supported chain slugs that have dedicated locators.
 */
function listDedicatedChains() {
  return Object.keys(LOCATOR_MAP);
}

module.exports = { getLocator, listDedicatedChains, LOCATOR_MAP };
