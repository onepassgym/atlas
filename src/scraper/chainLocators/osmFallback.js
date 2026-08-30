'use strict';
/**
 * OpenStreetMap Overpass API Fallback
 *
 * Generic chain location fetcher using OSM Overpass API.
 * Works for ANY space chain — just pass the brand name.
 * Free, no API key, global coverage (community maintained data).
 *
 * Overpass API docs: https://wiki.openstreetmap.org/wiki/Overpass_API
 */

const axios  = require('axios');
const logger = require('../../utils/logger');

const chainSlug = 'osm-fallback';

// Multiple Overpass API mirrors for reliability
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

/**
 * Build an Overpass QL query to find all fitness locations matching a brand name.
 * Searches nodes, ways, and relations with brand/name tags.
 */
function buildQuery(brandName) {
  // Escape special chars for Overpass regex
  const escaped = brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');

  return `
[out:json][timeout:120];
(
  node["leisure"="fitness_centre"]["brand"~"${escaped}",i];
  node["leisure"="fitness_centre"]["name"~"${escaped}",i];
  way["leisure"="fitness_centre"]["brand"~"${escaped}",i];
  way["leisure"="fitness_centre"]["name"~"${escaped}",i];
  node["leisure"="sports_centre"]["brand"~"${escaped}",i];
  node["leisure"="sports_centre"]["name"~"${escaped}",i];
  node["amenity"="space"]["brand"~"${escaped}",i];
  node["amenity"="space"]["name"~"${escaped}",i];
  way["amenity"="space"]["brand"~"${escaped}",i];
  way["amenity"="space"]["name"~"${escaped}",i];
);
out center body;
  `.trim();
}

/**
 * Extract address components from OSM tags.
 */
function extractAddress(tags) {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
    tags['addr:country'],
  ].filter(Boolean);
  return parts.join(', ') || null;
}

/**
 * Extract opening hours from OSM format.
 * OSM hours format: "Mo-Fr 06:00-22:00; Sa 08:00-20:00; Su 09:00-18:00"
 */
function parseOsmHours(hoursStr) {
  if (!hoursStr) return null;
  // Return raw string — processing can be done downstream
  return hoursStr;
}

/**
 * Normalize an Overpass API element into our standard location format.
 */
function normalizeElement(el, chainName) {
  const tags = el.tags || {};

  // For ways/relations, use center coordinates
  const lat = el.lat || el.center?.lat || null;
  const lng = el.lon || el.center?.lon || null;

  return {
    name:        tags.name || tags.brand || chainName,
    address:     extractAddress(tags),
    city:        tags['addr:city'] || null,
    state:       tags['addr:state'] || tags['addr:province'] || null,
    country:     tags['addr:country'] || null,
    countryCode: tags['addr:country'] || null,  // OSM uses ISO 2-letter codes
    postalCode:  tags['addr:postcode'] || null,
    lat,
    lng,
    phone:       tags.phone || tags['contact:phone'] || null,
    website:     tags.website || tags['contact:website'] || tags.url || null,
    hours:       parseOsmHours(tags.opening_hours),
    storeId:     `osm-${el.type}-${el.id}`,
    osmId:       el.id,
    osmType:     el.type,
    chainSlug:   null,  // will be set by caller
    chainName:   chainName,
  };
}

/**
 * Fetch all locations for a brand from OpenStreetMap.
 * @param {string} brandName - The brand name to search for (e.g., "Gold's Space")
 * @returns {Promise<Array>} Array of normalized locations
 */
async function fetchByBrand(brandName) {
  const query = buildQuery(brandName);
  let lastErr = null;

  // Try multiple Overpass mirrors
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      logger.info(`[OSM] Querying Overpass API for "${brandName}" via ${new URL(endpoint).hostname}...`);

      const { data } = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 120000,  // Overpass can be slow for global queries
      });

      const elements = data?.elements || [];
      const locations = elements
        .map(el => normalizeElement(el, brandName))
        .filter(l => l.lat && l.lng);

      logger.info(`[OSM] ✅ Found ${locations.length} locations for "${brandName}"`);
      return locations;

    } catch (err) {
      lastErr = err;
      logger.warn(`[OSM] ${new URL(endpoint).hostname} failed: ${err.message}`);
    }
  }

  logger.error(`[OSM] All Overpass endpoints failed for "${brandName}": ${lastErr?.message}`);
  return [];
}

/**
 * Main entry — used as fallback when no dedicated locator exists.
 * The chainSlug and chainName are set externally by the chain worker.
 */
async function fetchAllLocations(chainName) {
  return fetchByBrand(chainName || 'space');
}

module.exports = { fetchAllLocations, fetchByBrand, chainSlug };
