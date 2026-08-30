'use strict';
/**
 * Anytime Fitness Store Locator
 *
 * Fetches all space locations from the Anytime Fitness website.
 * Uses their public API / sitemap endpoint to discover locations worldwide.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');

const chainSlug = 'anytime-fitness';
const CHAIN_NAME = 'Anytime Fitness';

// Anytime Fitness exposes a location search API
const SEARCH_API = 'https://www.anytimefitness.com/wp-json/wp/v2/wp_gym_locations';
const SEARCH_RADIUS_URL = 'https://www.anytimefitness.com/find-space/';

// Region centroids to sweep for global coverage
const SEARCH_REGIONS = [
  // North America
  { lat: 39.8283, lng: -98.5795, label: 'US-Central' },
  { lat: 45.4215, lng: -75.6972, label: 'Canada' },
  { lat: 19.4326, lng: -99.1332, label: 'Mexico' },
  // Europe
  { lat: 51.5074, lng: -0.1278, label: 'UK' },
  { lat: 52.3676, lng: 4.9041, label: 'Netherlands' },
  { lat: 48.8566, lng: 2.3522, label: 'France' },
  { lat: 52.5200, lng: 13.4050, label: 'Germany' },
  { lat: 41.9028, lng: 12.4964, label: 'Italy' },
  { lat: 40.4168, lng: -3.7038, label: 'Spain' },
  // Asia-Pacific
  { lat: 19.0760, lng: 72.8777, label: 'India-Mumbai' },
  { lat: 12.9716, lng: 77.5946, label: 'India-Bangalore' },
  { lat: 28.6139, lng: 77.2090, label: 'India-Delhi' },
  { lat: 35.6762, lng: 139.6503, label: 'Japan' },
  { lat: -33.8688, lng: 151.2093, label: 'Australia' },
  { lat: -36.8485, lng: 174.7633, label: 'New Zealand' },
  { lat: 1.3521, lng: 103.8198,  label: 'Singapore' },
  { lat: 14.5995, lng: 120.9842, label: 'Philippines' },
  { lat: 13.7563, lng: 100.5018, label: 'Thailand' },
  // South America
  { lat: -23.5505, lng: -46.6333, label: 'Brazil' },
  { lat: -34.6037, lng: -58.3816, label: 'Argentina' },
];

/**
 * Normalize a raw space location into our standard format.
 */
function normalizeLocation(raw) {
  return {
    name:        raw.title?.rendered || raw.name || `${CHAIN_NAME}`,
    address:     raw.address || raw.street_address || null,
    city:        raw.city || null,
    state:       raw.state || raw.state_province || null,
    country:     raw.country || null,
    countryCode: raw.country_code || raw.country_short || null,
    postalCode:  raw.zip || raw.postal_code || null,
    lat:         parseFloat(raw.latitude || raw.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng || raw.lon) || null,
    phone:       raw.phone || raw.telephone || null,
    website:     raw.url || raw.website || raw.club_url || null,
    hours:       raw.hours || raw.opening_hours || null,
    storeId:     raw.id || raw.club_id || raw.gym_id || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

/**
 * Fetch locations via the WordPress REST API.
 */
async function fetchFromWPApi() {
  const locations = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    try {
      const { data } = await axios.get(SEARCH_API, {
        params: { per_page: perPage, page, _fields: 'id,title,acf,slug' },
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0' },
      });

      if (!data.length) break;

      for (const loc of data) {
        const acf = loc.acf || {};
        locations.push(normalizeLocation({
          id: loc.id,
          name: loc.title?.rendered,
          ...acf,
        }));
      }

      logger.info(`  [AnytimeFitness] Page ${page}: ${data.length} locations`);
      page++;

      if (data.length < perPage) break;
    } catch (err) {
      // WP API may not be available — fall back to search API
      if (page === 1) {
        logger.warn(`[AnytimeFitness] WP API unavailable: ${err.message}. Trying search API.`);
        return null;  // signal to use fallback
      }
      break;
    }
  }

  return locations;
}

/**
 * Fetch locations via Anytime Fitness location search API by sweeping regions.
 */
async function fetchFromSearchApi() {
  const allLocations = new Map();  // storeId → location (dedup)

  for (const region of SEARCH_REGIONS) {
    try {
      const { data } = await axios.get('https://www.anytimefitness.com/wp-json/anytime/v1/spaces', {
        params: {
          lat: region.lat,
          lng: region.lng,
          radius: 8000,       // km — large radius to capture region
          limit: 500,
        },
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          Accept: 'application/json',
        },
      });

      const spaces = Array.isArray(data) ? data : data?.spaces || data?.results || [];
      for (const space of spaces) {
        const loc = normalizeLocation(space);
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (!allLocations.has(key)) {
          allLocations.set(key, loc);
        }
      }

      logger.info(`  [AnytimeFitness] ${region.label}: ${spaces.length} spaces found (total unique: ${allLocations.size})`);
    } catch (err) {
      logger.warn(`  [AnytimeFitness] Region ${region.label} failed: ${err.message}`);
    }

    // Brief pause to be polite
    await new Promise(r => setTimeout(r, 500));
  }

  return [...allLocations.values()];
}

/**
 * Main entry: fetch all Anytime Fitness locations globally.
 */
async function fetchAllLocations() {
  logger.info(`[AnytimeFitness] Starting global location fetch...`);

  // Try WP API first (most reliable if available)
  let locations = await fetchFromWPApi();

  // Fall back to search API with region sweeping
  if (!locations || locations.length < 50) {
    logger.info(`[AnytimeFitness] Falling back to region sweep search API...`);
    locations = await fetchFromSearchApi();
  }

  // Filter out locations without lat/lng
  locations = locations.filter(l => l.lat && l.lng);

  logger.info(`[AnytimeFitness] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
