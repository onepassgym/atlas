'use strict';
/**
 * Cult.fit (CureFit) Store Locator
 *
 * Fetches all Cult.fit center locations — primarily India-based.
 * cult.fit exposes a public API for center discovery.
 */

const axios  = require('axios');
const logger = require('../../utils/logger');
const { assertLocatorRunSucceeded } = require('./_util');

const chainSlug = 'cult-fit';
const CHAIN_NAME = 'Cult.fit';

const SEARCH_API = 'https://www.cult.fit/api/cult/centers';
const ALT_API = 'https://www.cult.fit/api/centers';

// Cult.fit operates primarily in Indian cities
const SEARCH_CITIES = [
  { city: 'Bangalore', lat: 12.9716, lng: 77.5946 },
  { city: 'Mumbai', lat: 19.0760, lng: 72.8777 },
  { city: 'Delhi', lat: 28.6139, lng: 77.2090 },
  { city: 'Hyderabad', lat: 17.3850, lng: 78.4867 },
  { city: 'Chennai', lat: 13.0827, lng: 80.2707 },
  { city: 'Pune', lat: 18.5204, lng: 73.8567 },
  { city: 'Kolkata', lat: 22.5726, lng: 88.3639 },
  { city: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
  { city: 'Gurgaon', lat: 28.4595, lng: 77.0266 },
  { city: 'Noida', lat: 28.5355, lng: 77.3910 },
  { city: 'Jaipur', lat: 26.9124, lng: 75.7873 },
  { city: 'Chandigarh', lat: 30.7333, lng: 76.7794 },
  { city: 'Lucknow', lat: 26.8467, lng: 80.9462 },
  { city: 'Kochi', lat: 9.9312, lng: 76.2673 },
  { city: 'Indore', lat: 22.7196, lng: 75.8577 },
  { city: 'Coimbatore', lat: 11.0168, lng: 76.9558 },
  { city: 'Mysore', lat: 12.2958, lng: 76.6394 },
  { city: 'Vizag', lat: 17.6868, lng: 83.2185 },
];

function normalizeLocation(raw) {
  return {
    name:        raw.name || raw.centerName || `${CHAIN_NAME}`,
    address:     raw.address || raw.fullAddress || raw.addressLine1 || null,
    city:        raw.city || raw.cityName || null,
    state:       raw.state || null,
    country:     raw.country || 'India',
    countryCode: raw.countryCode || 'IN',
    postalCode:  raw.pincode || raw.postalCode || null,
    lat:         parseFloat(raw.latitude || raw.lat || raw.location?.lat) || null,
    lng:         parseFloat(raw.longitude || raw.lng || raw.lon || raw.location?.lng || raw.location?.lon) || null,
    phone:       raw.phone || raw.contactNumber || null,
    website:     raw.url || raw.centerUrl || null,
    hours:       raw.hours || raw.timings || null,
    storeId:     raw.id || raw.centerId || raw.center_id || null,
    chainSlug,
    chainName:   CHAIN_NAME,
  };
}

async function fetchAllLocations() {
  logger.info(`[CultFit] Starting location fetch across ${SEARCH_CITIES.length} Indian cities...`);
  const allLocations = new Map();
  let bulkFailed = false;

  // Try fetching all centers in one shot first
  try {
    const { data } = await axios.get(SEARCH_API, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        Accept: 'application/json',
      },
    });

    const centers = Array.isArray(data) ? data : data?.centers || data?.data || data?.result || [];
    for (const center of centers) {
      const loc = normalizeLocation(center);
      const key = loc.storeId || `${loc.lat},${loc.lng}`;
      if (loc.lat && loc.lng && !allLocations.has(key)) {
        allLocations.set(key, loc);
      }
    }

    if (allLocations.size > 20) {
      logger.info(`[CultFit] ✅ Bulk API returned ${allLocations.size} centers`);
      return [...allLocations.values()];
    }
  } catch (err) {
    bulkFailed = true;
    logger.warn(`[CultFit] Bulk API failed: ${err.message}. Trying per-city...`);
  }

  // Per-city fallback
  let cityFailed = 0;
  for (const { city, lat, lng } of SEARCH_CITIES) {
    try {
      const { data } = await axios.get(ALT_API, {
        params: { city, lat, lng, radius: 50 },
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          Accept: 'application/json',
        },
      });

      const centers = Array.isArray(data) ? data : data?.centers || data?.data || [];
      for (const center of centers) {
        const loc = normalizeLocation(center);
        loc.city = loc.city || city;
        const key = loc.storeId || `${loc.lat},${loc.lng}`;
        if (loc.lat && loc.lng && !allLocations.has(key)) {
          allLocations.set(key, loc);
        }
      }

      logger.info(`  [CultFit] ${city}: ${centers.length} centers (unique: ${allLocations.size})`);
    } catch (err) {
      cityFailed++;
      logger.warn(`  [CultFit] ${city} failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const locations = [...allLocations.values()];
  assertLocatorRunSucceeded({
    label: 'CultFit',
    attempted: SEARCH_CITIES.length,
    failed: bulkFailed && cityFailed === SEARCH_CITIES.length ? SEARCH_CITIES.length : cityFailed,
    found: locations.length,
  });
  logger.info(`[CultFit] ✅ Total locations fetched: ${locations.length}`);
  return locations;
}

module.exports = { fetchAllLocations, chainSlug, CHAIN_NAME };
