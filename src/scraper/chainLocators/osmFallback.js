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
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

// Public mirrors shed load with 429/504 at busy times. One extra pass over all
// mirrors after a pause recovers most of those.
const RETRY_ROUNDS = 2;
const RETRY_PAUSE_MS = 20000;

// Overpass rejects axios' default User-Agent with 406 Not Acceptable — it
// requires an identifiable client per its usage policy.
const OVERPASS_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent':   'OnePassGym-Atlas/1.0 (+https://onepassgym.com)',
  Accept:         'application/json',
};

/**
 * Build an Overpass QL query to find all fitness locations matching a brand name.
 *
 * Global queries use exact `brand`/`name` matches only — those hit Overpass'
 * tag index. A case-insensitive regex over every gym on the planet reliably
 * 504s. When scoped to countries, the area is small enough to also regex-match
 * names ("Anytime Fitness Koramangala" etc. that lack a brand tag).
 */
const quote = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function buildQuery(brandName, countries = []) {
  // "Gold's Gym" is tagged as "Gold's Gym", "Golds Gym" or "Gold’s Gym" in OSM.
  const variants = [...new Set([
    brandName,
    brandName.replace(/['’]/g, ''),
    brandName.replace(/'/g, '’'),
  ])].map(quote);

  // Scope to countries at query time: OSM rarely carries addr:country, so
  // post-filtering by country would discard nearly every result.
  const areas = countries.map(c => String(c).trim()).filter(Boolean).map(c => {
    const safe = quote(c);
    return /^[A-Za-z]{2}$/.test(c)
      ? `area["ISO3166-1"="${safe.toUpperCase()}"][admin_level=2];`
      : `area["name:en"="${safe}"][admin_level=2];`;
  });
  const scope = areas.length ? '(area.searchArea)' : '';
  const areaDecl = areas.length ? `(${areas.join(' ')})->.searchArea;\n` : '';

  const lines = variants.flatMap(v => [
    `  nwr["brand"="${v}"]${scope};`,
    `  nwr["name"="${v}"]${scope};`,
  ]);

  if (areas.length) {
    // Escape for Overpass regex, then make apostrophes optional.
    const pattern = quote(brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .replace(/['’]/g, "['’]?");
    for (const [k, v] of [['leisure', 'fitness_centre'], ['amenity', 'gym']]) {
      lines.push(`  nwr["${k}"="${v}"]["name"~"${pattern}",i]${scope};`);
    }
  }

  return `[out:json][timeout:180];\n${areaDecl}(\n${lines.join('\n')}\n);\nout center body;`;
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
 * @param {string} brandName - The brand name to search for (e.g., "Gold's Gym")
 * @param {{countries?: string[]}} [opts] - ISO-2 codes or English country names to scope the query
 * @returns {Promise<Array>} Array of normalized locations
 */
async function fetchByBrand(brandName, { countries = [] } = {}) {
  const query = buildQuery(brandName, countries);
  let lastErr = null;

  for (let round = 1; round <= RETRY_ROUNDS; round++) {
    if (round > 1) {
      logger.info(`[OSM] All mirrors failed — retrying in ${RETRY_PAUSE_MS / 1000}s (round ${round}/${RETRY_ROUNDS})...`);
      await new Promise(r => setTimeout(r, RETRY_PAUSE_MS));
    }
    // Try multiple Overpass mirrors
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        logger.info(`[OSM] Querying Overpass API for "${brandName}" via ${new URL(endpoint).hostname}...`);

        const { data } = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
          headers: OVERPASS_HEADERS,
          timeout: 200000,  // Overpass can be slow for global queries (server-side cap is 180s)
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
  }

  logger.error(`[OSM] All Overpass endpoints failed for "${brandName}": ${lastErr?.message}`);
  throw new Error(`[OSM] All Overpass endpoints failed for "${brandName}": ${lastErr?.message || 'unknown error'}`);
}

/**
 * Main entry — used as fallback when no dedicated locator exists.
 * The chainSlug and chainName are set externally by the chain worker.
 */
async function fetchAllLocations(chainName, opts) {
  return fetchByBrand(chainName || 'space', opts);
}

module.exports = { fetchAllLocations, fetchByBrand, chainSlug };
