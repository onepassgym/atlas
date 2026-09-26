'use strict';
/**
 * Planet Fitness Store Locator
 *
 * Fetches all Planet Fitness locations using their club search API.
 * Planet Fitness is primarily US-based with some international presence.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');
const { assertLocatorRunSucceeded } = require('./_util');

const chainSlug = 'planet-fitness';
const CHAIN_NAME = 'Planet Fitness';

const SEARCH_API = 'https://www.planetfitness.com/api/clubs';

// US state centroids + international regions
const SEARCH_REGIONS = [
  // Major US regions (Planet Fitness has 2400+ US locations)
  { lat: 40.7128, lng: -74.0060, label: 'US-NorthEast' },
  { lat: 33.7490, lng: -84.3880, label: 'US-SouthEast' },
  { lat: 41.8781, lng: -87.6298, label: 'US-MidWest' },
  { lat: 29.7604, lng: -95.3698, label: 'US-South' },
  { lat: 34.0522, lng: -118.2437, label: 'US-West' },
  { lat: 47.6062, lng: -122.3321, label: 'US-NorthWest' },
  { lat: 39.7392, lng: -104.9903, label: 'US-Mountain' },
  { lat: 25.7617, lng: -80.1918, label: 'US-Florida' },
  // Canada
  { lat: 43.6532, lng: -79.3832, label: 'Canada-Toronto' },
  { lat: 45.5017, lng: -73.5673, label: 'Canada-Montreal' },
  // International
  { lat: 19.4326, lng: -99.1332, label: 'Mexico' },
  { lat: -23.5505, lng: -46.6333, label: 'Brazil' },
  { lat: 51.5074, lng: -0.1278, label: 'UK' },
  { lat: -33.8688, lng: 151.2093, label: 'Australia' },
];

function normalizeLocation(raw) {
  return {
    name:        raw.name || raw.clubName || `${CHAIN_NAME}`,
    address:     raw.address || raw.streetAddress || raw.address1 || null,
    city:        raw.city || null,
    state:       raw.state || raw.province || null,
    country:     raw.country || 'US',
    countryCode: raw.countryCode || raw.country_code || 'US',
    postalCode:  raw.zip || raw.postalCode || null,
    lat:         parseFloat(raw.latitude || raw.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng || raw.lon) || null,
    phone:       raw.phone || raw.telephone || null,
    website:     raw.url || raw.clubUrl || null,
    hours:       raw.hours || null,
    storeId:     raw.id || raw.clubId || raw.club_number || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

async function fetchAllLocations() {
  logger.info(`[PlanetFitness] Starting global location fetch...`);
  const allLocations = new Map();
  let failed = 0;

  for (const region of SEARCH_REGIONS) {
    try {
      const { data } = await axios.get(SEARCH_API, {
        params: {
          latitude: region.lat,
          longitude: region.lng,
          radius: 5000,
          limit: 500,
        },
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          Accept: 'application/json',
        },
      });

      const clubs = Array.isArray(data) ? data : data?.clubs || data?.results || data?.data || [];
      for (const club of clubs) {
        const loc = normalizeLocation(club);
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (!allLocations.has(key)) allLocations.set(key, loc);
      }

      logger.info(`  [PlanetFitness] ${region.label}: ${clubs.length} found (unique: ${allLocations.size})`);
    } catch (err) {
      failed++;
      logger.warn(`  [PlanetFitness] ${region.label} failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  let locations = [...allLocations.values()].filter(l => l.lat && l.lng);
  assertLocatorRunSucceeded({
    label: 'PlanetFitness',
    attempted: SEARCH_REGIONS.length,
    failed,
    found: locations.length,
  });
  logger.info(`[PlanetFitness] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
