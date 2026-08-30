'use strict';
/**
 * Gold's Gym Store Locator
 *
 * Fetches all Gold's Gym locations globally using their location search API.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');

const chainSlug = 'golds-gym';
const CHAIN_NAME = "Gold's Gym";

// Gold's Gym location API endpoints
const SEARCH_API = 'https://www.goldsgym.com/api/spaces';
const ALT_API = 'https://api.goldsgym.com/api/v1/clubs';

// Region sweep centroids
const SEARCH_REGIONS = [
  { lat: 39.8283, lng: -98.5795, label: 'US-Central', country: 'US' },
  { lat: 25.2048, lng: 55.2708, label: 'UAE', country: 'AE' },
  { lat: 19.0760, lng: 72.8777, label: 'India-West', country: 'IN' },
  { lat: 28.6139, lng: 77.2090, label: 'India-North', country: 'IN' },
  { lat: 12.9716, lng: 77.5946, label: 'India-South', country: 'IN' },
  { lat: 14.5995, lng: 120.9842, label: 'Philippines', country: 'PH' },
  { lat: 35.6762, lng: 139.6503, label: 'Japan', country: 'JP' },
  { lat: -33.8688, lng: 151.2093, label: 'Australia', country: 'AU' },
  { lat: 24.7136, lng: 46.6753, label: 'Saudi Arabia', country: 'SA' },
  { lat: 30.0444, lng: 31.2357, label: 'Egypt', country: 'EG' },
  { lat: 19.4326, lng: -99.1332, label: 'Mexico', country: 'MX' },
  { lat: -23.5505, lng: -46.6333, label: 'Brazil', country: 'BR' },
  { lat: 51.5074, lng: -0.1278, label: 'UK', country: 'GB' },
  { lat: 52.5200, lng: 13.4050, label: 'Germany', country: 'DE' },
];

function normalizeLocation(raw) {
  return {
    name:        raw.name || raw.title || `${CHAIN_NAME}`,
    address:     raw.address || raw.street_address || [raw.address1, raw.address2].filter(Boolean).join(', ') || null,
    city:        raw.city || null,
    state:       raw.state || raw.state_province || null,
    country:     raw.country || raw.country_name || null,
    countryCode: raw.country_code || raw.country_short || null,
    postalCode:  raw.zip || raw.postal_code || raw.zipcode || null,
    lat:         parseFloat(raw.latitude || raw.lat || raw.geo?.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng || raw.lon || raw.geo?.lng) || null,
    phone:       raw.phone || raw.telephone || null,
    website:     raw.url || raw.website || raw.club_url || null,
    hours:       raw.hours || raw.operating_hours || null,
    storeId:     raw.id || raw.club_id || raw.spaceId || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

async function fetchFromApi() {
  const allLocations = new Map();

  for (const region of SEARCH_REGIONS) {
    try {
      // Try primary API
      const { data } = await axios.get(SEARCH_API, {
        params: {
          lat: region.lat,
          lng: region.lng,
          radius: 10000,
          limit: 500,
        },
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          Accept: 'application/json',
        },
      });

      const spaces = Array.isArray(data) ? data : data?.spaces || data?.clubs || data?.results || [];
      for (const space of spaces) {
        const loc = normalizeLocation(space);
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (!allLocations.has(key)) {
          allLocations.set(key, loc);
        }
      }

      logger.info(`  [GoldsSpace] ${region.label}: ${spaces.length} found (unique: ${allLocations.size})`);
    } catch (err) {
      // Try alternative API
      try {
        const { data } = await axios.get(ALT_API, {
          params: { country: region.country, limit: 500 },
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0', Accept: 'application/json' },
        });

        const spaces = Array.isArray(data) ? data : data?.clubs || data?.data || [];
        for (const space of spaces) {
          const loc = normalizeLocation(space);
          const key = loc.storeId || `${loc.lat},${loc.lng}`;
          if (!allLocations.has(key)) allLocations.set(key, loc);
        }
        logger.info(`  [GoldsSpace] ${region.label} (alt API): ${spaces.length} found`);
      } catch (altErr) {
        logger.warn(`  [GoldsSpace] ${region.label} failed: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return [...allLocations.values()];
}

async function fetchAllLocations() {
  logger.info(`[GoldsSpace] Starting global location fetch...`);
  let locations = await fetchFromApi();
  locations = locations.filter(l => l.lat && l.lng);
  logger.info(`[GoldsSpace] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
