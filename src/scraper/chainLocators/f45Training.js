'use strict';
/**
 * F45 Training Store Locator
 *
 * Fetches all F45 Training studio locations globally.
 * F45 has a public studio finder API.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');
const { assertLocatorRunSucceeded } = require('./_util');

const chainSlug = 'f45-training';
const CHAIN_NAME = 'F45 Training';

const SEARCH_API = 'https://f45training.com/find-a-studio';
const API_ENDPOINT = 'https://f45training.com/api/v1/studios';

const SEARCH_REGIONS = [
  { lat: 39.8283, lng: -98.5795, label: 'US-Central' },
  { lat: 40.7128, lng: -74.0060, label: 'US-East' },
  { lat: 34.0522, lng: -118.2437, label: 'US-West' },
  { lat: -33.8688, lng: 151.2093, label: 'Australia-Sydney' },
  { lat: -37.8136, lng: 144.9631, label: 'Australia-Melbourne' },
  { lat: -27.4698, lng: 153.0251, label: 'Australia-Brisbane' },
  { lat: 51.5074, lng: -0.1278, label: 'UK' },
  { lat: 25.2048, lng: 55.2708, label: 'UAE' },
  { lat: 1.3521, lng: 103.8198, label: 'Singapore' },
  { lat: 19.0760, lng: 72.8777, label: 'India' },
  { lat: 43.6532, lng: -79.3832, label: 'Canada' },
  { lat: -36.8485, lng: 174.7633, label: 'New Zealand' },
  { lat: 13.7563, lng: 100.5018, label: 'Thailand' },
  { lat: 3.1390, lng: 101.6869, label: 'Malaysia' },
  { lat: 48.8566, lng: 2.3522, label: 'France' },
  { lat: 52.5200, lng: 13.4050, label: 'Germany' },
];

function normalizeLocation(raw) {
  return {
    name:        raw.name || raw.studio_name || `${CHAIN_NAME}`,
    address:     raw.address || raw.street || null,
    city:        raw.city || raw.suburb || null,
    state:       raw.state || raw.region || null,
    country:     raw.country || null,
    countryCode: raw.country_code || null,
    postalCode:  raw.zip || raw.postcode || raw.postal_code || null,
    lat:         parseFloat(raw.latitude || raw.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng) || null,
    phone:       raw.phone || null,
    website:     raw.url || raw.website || null,
    hours:       raw.hours || null,
    storeId:     raw.id || raw.studio_id || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

async function fetchAllLocations() {
  logger.info(`[F45Training] Starting global location fetch...`);
  const allLocations = new Map();
  let failed = 0;

  for (const region of SEARCH_REGIONS) {
    try {
      const { data } = await axios.get(API_ENDPOINT, {
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

      const studios = Array.isArray(data) ? data : data?.studios || data?.results || data?.data || [];
      for (const studio of studios) {
        const loc = normalizeLocation(studio);
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (!allLocations.has(key)) allLocations.set(key, loc);
      }

      logger.info(`  [F45Training] ${region.label}: ${studios.length} found (unique: ${allLocations.size})`);
    } catch (err) {
      failed++;
      logger.warn(`  [F45Training] ${region.label} failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  let locations = [...allLocations.values()].filter(l => l.lat && l.lng);
  assertLocatorRunSucceeded({
    label: 'F45Training',
    attempted: SEARCH_REGIONS.length,
    failed,
    found: locations.length,
  });
  logger.info(`[F45Training] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
