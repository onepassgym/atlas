'use strict';
/**
 * YelpSource — Yelp Fusion API + Playwright scrape fallback.
 * Uses official API when key is configured; falls back to scraping for non-API regions.
 */

const axios = require('axios');
const BaseSourceScraper = require('./BaseSourceScraper');
const cfg = require('../../../config');
const logger = require('../../utils/logger');

const YELP_API_BASE = 'https://api.yelp.com/v3';
const FITNESS_TERMS = [
  'gym', 'fitness', 'yoga', 'pilates', 'crossfit', 'boxing',
  'martial arts', 'personal training', 'swimming', 'dance studio',
];

class YelpSource extends BaseSourceScraper {
  constructor() {
    super();
    this.sourceId = 'yelp';
    this._apiKey  = null; // set lazily from config
  }

  _getApiKey() {
    if (!this._apiKey) this._apiKey = cfg.sources?.yelpApiKey || '';
    return this._apiKey;
  }

  canHandleUrl(url) {
    return /yelp\.com\/biz\//i.test(url);
  }

  async searchByArea(area, categories = []) {
    const key = this._getApiKey();
    if (!key) {
      this._log('info', 'No Yelp API key — skipping area search');
      return [];
    }

    const results = [];
    const terms = categories.length > 0 ? categories.slice(0, 3) : FITNESS_TERMS.slice(0, 3);

    for (const term of terms) {
      try {
        const hits = await this._apiFetch('/businesses/search', {
          term,
          location: area,
          categories: 'fitness,gyms,yoga,pilates,martialarts,swimming',
          limit: 50,
        });
        results.push(...(hits?.businesses || []).map(b => this._normalizeApi(b)));
        await this.sleep(300, 600);
      } catch (err) {
        this._log('warn', `Area search failed for "${term}": ${err.message}`);
      }
    }

    return this._dedup(results);
  }

  async searchByName(name, location = null, categories = []) {
    const key = this._getApiKey();
    if (!key) return [];

    try {
      const params = {
        term: name,
        categories: 'fitness,gyms,yoga,pilates,martialarts',
        limit: 20,
      };
      if (location) params.location = location;
      const hits = await this._apiFetch('/businesses/search', params);
      const businesses = hits?.businesses || [];
      return businesses
        .filter(b => {
          const n = (b.name || '').toLowerCase();
          return name.toLowerCase().split(' ').some(w => w.length > 2 && n.includes(w));
        })
        .map(b => this._normalizeApi(b));
    } catch (err) {
      this._log('warn', `Name search failed: ${err.message}`);
      return [];
    }
  }

  async scrapeByUrl(url) {
    if (!this.canHandleUrl(url)) return null;
    const key = this._getApiKey();

    // Extract business alias from URL: yelp.com/biz/gold-gym-delhi → gold-gym-delhi
    const alias = url.match(/\/biz\/([^?#/]+)/)?.[1];
    if (!alias) return null;

    if (key) {
      try {
        const biz = await this._apiFetch(`/businesses/${encodeURIComponent(alias)}`, {});
        if (biz) return this._normalizeApi(biz, true);
      } catch (_) {}
    }

    // Fallback: Playwright scrape
    return this._scrapeYelpPage(url);
  }

  async _scrapeYelpPage(url) {
    await this._launchBrowser();
    const page = await this._newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(1500, 2500);

      const data = await page.evaluate(() => {
        const get = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
        const name    = document.querySelector('h1')?.textContent?.trim() || null;
        const rating  = parseFloat(document.querySelector('[data-font-weight="semibold"]')?.textContent || '0') || null;
        const address = get('[data-testid="addressWrapper"]') || get('.css-qyp8bo');
        const phone   = get('[data-testid="phoneNumber"]');
        const website = document.querySelector('[data-testid="bizWebsite"] a')?.href || null;
        const hours   = [...document.querySelectorAll('[data-testid="hours-table"] tr')].map(row => ({
          day: row.querySelector('th')?.textContent?.trim() || '',
          raw: row.querySelector('td')?.textContent?.trim() || '',
        }));
        return { name, rating, address, phone, website, hours };
      });

      if (!data.name) return null;
      return this._normalize(data, url);
    } finally {
      await this._closeBrowser();
    }
  }

  async _apiFetch(path, params) {
    const resp = await axios.get(`${YELP_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this._getApiKey()}` },
      params,
      timeout: 15000,
    });
    return resp.data;
  }

  _normalizeApi(b, deep = false) {
    const loc    = b.location || {};
    const coords = b.coordinates || {};
    const phone  = b.display_phone?.replace(/[^0-9+]/g, '') || null;

    return {
      sourceId:     this.sourceId,
      name:         b.name || null,
      lat:          coords.latitude  ?? null,
      lng:          coords.longitude ?? null,
      address:      [loc.address1, loc.address2, loc.city, loc.state, loc.zip_code].filter(Boolean).join(', '),
      city:         loc.city || null,
      state:        loc.state || null,
      pincode:      loc.zip_code || null,
      country:      loc.country || null,
      contact: {
        phone:   phone,
        website: b.url || null,
        email:   null,
      },
      rating:       b.rating ?? null,
      totalReviews: b.review_count || 0,
      categories:   (b.categories || []).map(c => c.title),
      description:  null,
      priceLevel:   this._mapPriceLevel(b.price),
      photos:       b.photos || (b.image_url ? [b.image_url] : []),
      rawPhotoUrls: b.photos || (b.image_url ? [b.image_url] : []),
      reviews:      [],
      sourceUrl:    b.url || null,
      confidence:   0.80,
    };
  }

  _normalize(raw, sourceUrl) {
    return {
      sourceId:     this.sourceId,
      name:         raw.name    || null,
      address:      raw.address || null,
      contact: {
        phone:   raw.phone   ? raw.phone.replace(/[^0-9+]/g, '') : null,
        website: raw.website || null,
        email:   null,
      },
      rating:       raw.rating ?? null,
      openingHours: (raw.hours || []).map(h => ({ day: h.day, raw: h.raw })),
      categories:   [],
      photos:       [],
      rawPhotoUrls: [],
      reviews:      [],
      sourceUrl,
      confidence:   0.60,
    };
  }

  _mapPriceLevel(price) {
    if (!price) return null;
    if (price.length <= 1) return 'budget';
    if (price.length === 2) return 'mid';
    return 'premium';
  }

  _dedup(results) {
    const seen = new Set();
    return results.filter(r => {
      const key = (r.name || '').toLowerCase().replace(/\s+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = new YelpSource();
