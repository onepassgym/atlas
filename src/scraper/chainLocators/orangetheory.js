'use strict';
/**
 * Orangetheory Fitness Store Locator
 *
 * Fetches all Orangetheory Fitness studio locations globally.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');
const { assertLocatorRunSucceeded } = require('./_util');

const chainSlug = 'orangetheory';
const CHAIN_NAME = 'Orangetheory Fitness';

const SEARCH_API = 'https://api.orangetheory.co/partners/v1/studios';
const ALT_SEARCH = 'https://www.orangetheory.com/bin/otf/studios';

const SEARCH_REGIONS = [
  { lat: 40.7128, lng: -74.0060, label: 'US-NorthEast' },
  { lat: 33.7490, lng: -84.3880, label: 'US-SouthEast' },
  { lat: 41.8781, lng: -87.6298, label: 'US-MidWest' },
  { lat: 34.0522, lng: -118.2437, label: 'US-West' },
  { lat: 29.7604, lng: -95.3698, label: 'US-South' },
  { lat: 25.7617, lng: -80.1918, label: 'US-Florida' },
  { lat: 47.6062, lng: -122.3321, label: 'US-Pacific' },
  { lat: 43.6532, lng: -79.3832, label: 'Canada' },
  { lat: 51.5074, lng: -0.1278, label: 'UK' },
  { lat: -33.8688, lng: 151.2093, label: 'Australia' },
  { lat: 35.6762, lng: 139.6503, label: 'Japan' },
  { lat: 25.2048, lng: 55.2708, label: 'UAE' },
  { lat: 1.3521, lng: 103.8198, label: 'Singapore' },
  { lat: 19.4326, lng: -99.1332, label: 'Mexico' },
  { lat: -23.5505, lng: -46.6333, label: 'Brazil' },
  { lat: 52.5200, lng: 13.4050, label: 'Germany' },
  { lat: 48.8566, lng: 2.3522, label: 'France' },
];

function normalizeLocation(raw) {
  return {
    name:        raw.name || raw.studioName || `${CHAIN_NAME}`,
    address:     raw.address || raw.physicalAddress || raw.street || null,
    city:        raw.city || raw.physicalCity || null,
    state:       raw.state || raw.physicalState || null,
    country:     raw.country || raw.physicalCountry || null,
    countryCode: raw.countryCode || raw.country_code || null,
    postalCode:  raw.zip || raw.postalCode || raw.physicalPostalCode || null,
    lat:         parseFloat(raw.latitude || raw.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng || raw.lon) || null,
    phone:       raw.phone || raw.phoneNumber || null,
    website:     raw.url || raw.studioUrl || raw.website || null,
    hours:       raw.hours || raw.studioHours || null,
    storeId:     raw.studioId || raw.id || raw.studio_id || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

async function fetchAllLocations() {
  logger.info(`[Orangetheory] Starting global location fetch...`);
  const allLocations = new Map();
  let failed = 0;

  for (const region of SEARCH_REGIONS) {
    let regionFailed = false;
    try {
      const { data } = await axios.get(SEARCH_API, {
        params: {
          latitude: region.lat,
          longitude: region.lng,
          distance: 8000,
          limit: 500,
        },
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          Accept: 'application/json',
        },
      });

      const studios = Array.isArray(data) ? data : data?.studios || data?.data || data?.results || [];
      for (const studio of studios) {
        const loc = normalizeLocation(studio);
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (!allLocations.has(key)) allLocations.set(key, loc);
      }

      logger.info(`  [Orangetheory] ${region.label}: ${studios.length} found (unique: ${allLocations.size})`);
    } catch (err) {
      // Alt endpoint keeps regionFailed true unless it also succeeds.
      regionFailed = true;
      try {
        const { data } = await axios.get(ALT_SEARCH, {
          params: { lat: region.lat, lng: region.lng, radius: 8000 },
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0', Accept: 'application/json' },
        });

        const studios = Array.isArray(data) ? data : data?.studios || data?.data || [];
        for (const studio of studios) {
          const loc = normalizeLocation(studio);
          const key = loc.storeId || `${loc.lat},${loc.lng}`;
          if (!allLocations.has(key)) allLocations.set(key, loc);
        }
        regionFailed = false;
        logger.info(`  [Orangetheory] ${region.label} (alt): ${studios.length} found`);
      } catch (altErr) {
        logger.warn(`  [Orangetheory] ${region.label} failed: ${err.message}`);
      }
    }
    if (regionFailed) failed++;

    await new Promise(r => setTimeout(r, 500));
  }

  let locations = [...allLocations.values()].filter(l => l.lat && l.lng);
  assertLocatorRunSucceeded({
    label: 'Orangetheory',
    attempted: SEARCH_REGIONS.length,
    failed,
    found: locations.length,
  });
  logger.info(`[Orangetheory] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
