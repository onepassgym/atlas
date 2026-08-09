'use strict';
/**
 * GoogleMapsSource — adapter wrapping the existing googleMapsScraper.
 * Implements the BaseSourceScraper interface.
 */

const BaseSourceScraper = require('./BaseSourceScraper');
const {
  BrowserManager,
  searchGymsInCity,
  scrapeGymDetail,
  scrapeEnrichmentDetail,
  FITNESS_CATEGORIES,
} = require('../googleMapsScraper');
const logger = require('../../utils/logger');

// Expanded fitness search categories beyond the original 10
const EXPANDED_CATEGORIES = [
  ...FITNESS_CATEGORIES,
  'hiit studio',
  'functional training gym',
  'ems studio',
  'calisthenics gym',
  'aerial yoga',
  'barre studio',
  'cycling studio',
  'zumba class',
  'swimming pool',
  'badminton court',
  'tennis academy',
  'basketball court',
  'cricket academy',
  'climbing wall',
  'mma gym',
  'physiotherapy',
];

// Deduplicate
const ALL_CATEGORIES = [...new Set(EXPANDED_CATEGORIES)];

class GoogleMapsSource extends BaseSourceScraper {
  constructor() {
    super();
    this.sourceId = 'google_maps';
    this._bm = null;
  }

  canHandleUrl(url) {
    return /google\.(com|co\.[a-z]+)\/maps\//i.test(url);
  }

  async searchByArea(area, categories = []) {
    const cats = categories.length > 0 ? categories : ALL_CATEGORIES;
    const results = [];
    this._bm = new BrowserManager();
    const ctx = await this._bm.launch();
    const page = await ctx.newPage();

    try {
      for (const cat of cats) {
        const found = await searchGymsInCity(page, area, [cat]);
        results.push(...found);
        await this.sleep(800, 1500);
      }
    } finally {
      await this._bm.close();
    }

    return results.map(r => this._normalize(r));
  }

  async searchByName(name, location = null, categories = []) {
    const query = location ? `${name} ${location}` : name;
    this._bm = new BrowserManager();
    const ctx = await this._bm.launch();
    const page = await ctx.newPage();

    try {
      const found = await searchGymsInCity(page, query, categories.length > 0 ? categories : ['gym', 'fitness center']);
      const filtered = found.filter(r => {
        const n = (r.name || '').toLowerCase();
        const q = name.toLowerCase();
        // Keep results that contain at least one word from the search name
        return q.split(' ').some(word => word.length > 2 && n.includes(word));
      });
      return filtered.map(r => this._normalize(r));
    } finally {
      await this._bm.close();
    }
  }

  async scrapeByUrl(url) {
    if (!this.canHandleUrl(url)) return null;

    this._bm = new BrowserManager();
    const ctx = await this._bm.launch();
    const page = await ctx.newPage();

    try {
      const raw = await scrapeGymDetail(page, url, 'deep');
      if (!raw) return null;
      return this._normalize({ ...raw, googleMapsUrl: url });
    } finally {
      await this._bm.close();
    }
  }

  async enrichSpace(space, stages = ['all']) {
    const url = space.googleMapsUrl || space.crawl?.sourceUrl;
    if (!url) return {};

    this._bm = new BrowserManager();
    const ctx = await this._bm.launch();
    const page = await ctx.newPage();

    try {
      const raw = await scrapeEnrichmentDetail(page, url);
      if (!raw) return {};
      return this._normalize(raw);
    } finally {
      await this._bm.close();
    }
  }

  _normalize(raw) {
    return {
      sourceId:      this.sourceId,
      name:          raw.name,
      placeId:       raw.placeId        || null,
      googleMapsUrl: raw.googleMapsUrl  || null,
      address:       raw.address        || null,
      city:          raw.city           || raw.areaName || null,
      areaName:      raw.areaName       || null,
      state:         raw.state          || null,
      pincode:       raw.pincode        || null,
      country:       raw.country        || 'IN',
      lat:           raw.lat            ?? null,
      lng:           raw.lng            ?? null,
      rating:        raw.rating         ?? null,
      totalReviews:  raw.totalReviews   || 0,
      ratingBreakdown: raw.ratingBreakdown || {},
      contact: {
        phone:   raw.phone   || raw.contact?.phone   || null,
        website: raw.website || raw.contact?.website || null,
        email:   raw.email   || raw.contact?.email   || null,
      },
      openingHours:   raw.openingHours   || [],
      isOpenNow:      raw.isOpenNow      ?? null,
      description:    raw.description    || null,
      priceLevel:     raw.priceLevel     || null,
      categories:     raw.categories     || (raw.category ? [raw.category] : []),
      amenities:      raw.amenities      || { raw: [] },
      highlights:     raw.highlights     || [],
      offerings:      raw.offerings      || [],
      serviceOptions: raw.serviceOptions || [],
      photos:         raw.photoUrls      || [],
      rawPhotoUrls:   raw.photoUrls      || [],
      reviews:        raw.reviews        || [],
      sourceUrl:      raw.googleMapsUrl  || null,
      confidence:     0.9,
    };
  }
}

module.exports = new GoogleMapsSource();
