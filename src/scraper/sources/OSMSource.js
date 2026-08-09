'use strict';
/**
 * OSMSource — OpenStreetMap Overpass API source adapter.
 * Free, global coverage, no API key. Promotes osmFallback to a full ISourceScraper.
 *
 * OSM fitness tags queried:
 *   leisure=fitness_centre, leisure=sports_centre, leisure=yoga, leisure=swimming_pool,
 *   amenity=gym, sport=* on fitness nodes, leisure=pitch for court sports
 */

const axios = require('axios');
const BaseSourceScraper = require('./BaseSourceScraper');
const logger = require('../../utils/logger');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

// All OSM tags that represent fitness venues (expanded for India coverage)
const OSM_FITNESS_FILTERS = [
  '["leisure"="fitness_centre"]',
  '["leisure"="sports_centre"]',
  '["leisure"="yoga"]',
  '["leisure"="swimming_pool"]',
  '["leisure"="martial_arts"]',
  '["leisure"="dance"]',
  '["amenity"="gym"]',
  '["amenity"="swimming_pool"]',
  // India-relevant sport= tags common on OSM India data
  '["sport"="fitness"]',
  '["sport"="yoga"]',
  '["sport"="martial_arts"]',
  '["sport"="swimming"]',
  '["sport"="dance"]',
  '["sport"="crossfit"]',
  '["sport"="boxing"]',
  '["sport"="weightlifting"]',
  '["sport"="badminton"]',
  '["sport"="cricket"]',
  '["sport"="tennis"]',
  '["sport"="basketball"]',
];

class OSMSource extends BaseSourceScraper {
  constructor() {
    super();
    this.sourceId = 'osm';
  }

  canHandleUrl(url) {
    return /openstreetmap\.org|osm\.org/i.test(url);
  }

  async searchByArea(area, categories = []) {
    // Geocode the area name to a bounding box first
    const bbox = await this._geocodeToBbox(area);
    if (!bbox) {
      this._log('warn', `Could not geocode: ${area}`);
      return [];
    }

    const query = this._buildAreaQuery(bbox, categories);
    const elements = await this._runQuery(query);
    return elements.map(el => this._normalize(el));
  }

  async searchByName(name, location = null, categories = []) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');
    let areaClause = '';

    if (location) {
      const bbox = await this._geocodeToBbox(location);
      if (bbox) {
        areaClause = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
      }
    }

    const query = `
[out:json][timeout:60];
(
  node["name"~"${escaped}",i]["leisure"~"fitness_centre|sports_centre|yoga|swimming_pool|martial_arts"]${areaClause};
  node["name"~"${escaped}",i]["amenity"~"gym|swimming_pool"]${areaClause};
  way["name"~"${escaped}",i]["leisure"~"fitness_centre|sports_centre"]${areaClause};
);
out center body;`.trim();

    const elements = await this._runQuery(query);
    return elements.map(el => this._normalize(el));
  }

  async scrapeByUrl(url) {
    // OSM node/way URLs: https://www.openstreetmap.org/node/12345678
    const match = url.match(/\/(node|way|relation)\/(\d+)/);
    if (!match) return null;

    const [, type, id] = match;
    const query = `[out:json];${type}(${id});out body;`;
    const elements = await this._runQuery(query);
    if (!elements.length) return null;
    return this._normalize(elements[0]);
  }

  // ── Geocode area name → bounding box via Nominatim ───────────────────────
  async _geocodeToBbox(area) {
    try {
      const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          q: area,
          format: 'json',
          limit: 1,
          featuretype: 'city,town,suburb,neighbourhood',
        },
        headers: { 'User-Agent': 'ATLAS-FitnessDataScraper/1.0' },
        timeout: 10000,
      });

      const hit = resp.data?.[0];
      if (!hit?.boundingbox) return null;
      const [south, north, west, east] = hit.boundingbox.map(Number);
      // Expand slightly for suburbs
      const pad = 0.05;
      return { south: south - pad, north: north + pad, west: west - pad, east: east + pad };
    } catch (err) {
      this._log('warn', `Geocode failed for "${area}": ${err.message}`);
      return null;
    }
  }

  _buildAreaQuery(bbox, categories = []) {
    const { south, west, north, east } = bbox;
    const bboxStr = `(${south},${west},${north},${east})`;

    const filters = categories.length > 0
      ? this._categoriesToOsmFilters(categories)
      : OSM_FITNESS_FILTERS;

    const nodeLines = filters.map(f => `  node${f}${bboxStr};`).join('\n');
    const wayLines  = filters.map(f => `  way${f}${bboxStr};`).join('\n');

    return `
[out:json][timeout:90];
(
${nodeLines}
${wayLines}
);
out center body;`.trim();
  }

  _categoriesToOsmFilters(categories) {
    const map = {
      gym:            ['["leisure"="fitness_centre"]', '["amenity"="gym"]'],
      yoga:           ['["leisure"="yoga"]', '["leisure"="fitness_centre"]["sport"="yoga"]'],
      swimming:       ['["leisure"="swimming_pool"]', '["amenity"="swimming_pool"]'],
      martial:        ['["leisure"="martial_arts"]'],
      sports:         ['["leisure"="sports_centre"]'],
    };
    const filters = new Set();
    for (const cat of categories) {
      const l = cat.toLowerCase();
      for (const [key, vals] of Object.entries(map)) {
        if (l.includes(key)) vals.forEach(v => filters.add(v));
      }
    }
    if (filters.size === 0) return OSM_FITNESS_FILTERS;
    return [...filters];
  }

  async _runQuery(query) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const resp = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 90000,
        });
        return resp.data?.elements || [];
      } catch (err) {
        this._log('warn', `Overpass endpoint ${endpoint} failed: ${err.message}`);
      }
    }
    this._log('warn', 'All Overpass endpoints failed');
    return [];
  }

  _normalize(el) {
    const tags = el.tags || {};
    const lat  = el.lat ?? el.center?.lat ?? null;
    const lng  = el.lon ?? el.center?.lon ?? null;

    const phone   = tags['phone'] || tags['contact:phone'] || null;
    const website = tags['website'] || tags['contact:website'] || null;
    const email   = tags['email'] || tags['contact:email'] || null;
    const name    = tags['name'] || tags['brand'] || null;

    const addressParts = [
      tags['addr:housenumber'],
      tags['addr:street'],
      tags['addr:suburb'],
      tags['addr:city'],
      tags['addr:state'],
      tags['addr:postcode'],
    ].filter(Boolean);

    const osmUrl = el.type && el.id
      ? `https://www.openstreetmap.org/${el.type}/${el.id}`
      : null;

    return {
      sourceId:     this.sourceId,
      name,
      lat,
      lng,
      address:      addressParts.join(', ') || null,
      city:         tags['addr:city']    || null,
      areaName:     tags['addr:suburb']  || tags['addr:neighbourhood'] || null,
      state:        tags['addr:state']   || null,
      pincode:      tags['addr:postcode']|| null,
      country:      tags['addr:country'] || tags['addr:country_code'] || 'IN',
      contact: {
        phone:   phone   ? phone.replace(/[^0-9+]/g, '') : null,
        website: website || null,
        email:   email   || null,
      },
      openingHours: tags['opening_hours'] ? [{ raw: tags['opening_hours'] }] : [],
      categories:   this._extractCategories(tags),
      amenities:    { raw: this._extractAmenities(tags) },
      description:  tags['description'] || null,
      photos:       [],
      rawPhotoUrls: [],
      reviews:      [],
      sourceUrl:    osmUrl,
      confidence:   0.55,
    };
  }

  _extractCategories(tags) {
    const cats = [];
    const leisure = tags['leisure'];
    const amenity = tags['amenity'];
    const sport   = tags['sport'];
    if (leisure === 'fitness_centre') cats.push('gym');
    if (leisure === 'sports_centre')  cats.push('sports complex');
    if (leisure === 'yoga')           cats.push('yoga studio');
    if (leisure === 'swimming_pool' || amenity === 'swimming_pool') cats.push('swimming pool');
    if (leisure === 'martial_arts')   cats.push('martial arts');
    if (amenity  === 'gym')           cats.push('gym');
    if (sport) cats.push(sport);
    return [...new Set(cats)];
  }

  _extractAmenities(tags) {
    const amens = [];
    if (tags['swimming_pool'] || tags['leisure'] === 'swimming_pool') amens.push('swimming pool');
    if (tags['sauna'] === 'yes')   amens.push('sauna');
    if (tags['parking'] === 'yes' || tags['amenity'] === 'parking') amens.push('parking');
    if (tags['wheelchair'] === 'yes') amens.push('wheelchair accessible');
    return amens;
  }
}

module.exports = new OSMSource();
