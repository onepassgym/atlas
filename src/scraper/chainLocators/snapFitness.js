'use strict';
/**
 * Snap Fitness Store Locator
 *
 * Fetches all Snap Fitness 24/7 locations globally.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');

const chainSlug = 'snap-fitness';
const CHAIN_NAME = 'Snap Fitness';

const SEARCH_API = 'https://www.snapfitness.com/api/spaces';

const SEARCH_REGIONS = [
  { lat: 44.9778, lng: -93.2650, label: 'US-Minnesota' },
  { lat: 40.7128, lng: -74.0060, label: 'US-NorthEast' },
  { lat: 34.0522, lng: -118.2437, label: 'US-West' },
  { lat: 29.7604, lng: -95.3698, label: 'US-South' },
  { lat: 41.8781, lng: -87.6298, label: 'US-MidWest' },
  { lat: 19.0760, lng: 72.8777, label: 'India-Mumbai' },
  { lat: 28.6139, lng: 77.2090, label: 'India-Delhi' },
  { lat: 12.9716, lng: 77.5946, label: 'India-Bangalore' },
  { lat: -33.8688, lng: 151.2093, label: 'Australia' },
  { lat: -36.8485, lng: 174.7633, label: 'New Zealand' },
  { lat: 51.5074, lng: -0.1278, label: 'UK' },
  { lat: 43.6532, lng: -79.3832, label: 'Canada' },
  { lat: 14.5995, lng: 120.9842, label: 'Philippines' },
];

function normalizeLocation(raw) {
  return {
    name:        raw.name || raw.title || `${CHAIN_NAME}`,
    address:     raw.address || raw.street_address || null,
    city:        raw.city || null,
    state:       raw.state || raw.province || null,
    country:     raw.country || null,
    countryCode: raw.country_code || null,
    postalCode:  raw.zip || raw.postal_code || null,
    lat:         parseFloat(raw.latitude || raw.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng) || null,
    phone:       raw.phone || null,
    website:     raw.url || raw.website || null,
    hours:       raw.hours || null,
    storeId:     raw.id || raw.club_id || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

async function fetchAllLocations() {
  logger.info(`[SnapFitness] Starting global location fetch...`);
  const allLocations = new Map();

  for (const region of SEARCH_REGIONS) {
    try {
      const { data } = await axios.get(SEARCH_API, {
        params: {
          lat: region.lat,
          lng: region.lng,
          radius: 8000,
          limit: 500,
        },
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          Accept: 'application/json',
        },
      });

      const spaces = Array.isArray(data) ? data : data?.spaces || data?.results || data?.data || [];
      for (const space of spaces) {
        const loc = normalizeLocation(space);
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (!allLocations.has(key)) allLocations.set(key, loc);
      }

      logger.info(`  [SnapFitness] ${region.label}: ${spaces.length} found (unique: ${allLocations.size})`);
    } catch (err) {
      logger.warn(`  [SnapFitness] ${region.label} failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  let locations = [...allLocations.values()].filter(l => l.lat && l.lng);
  logger.info(`[SnapFitness] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
