'use strict';
/**
 * OfficialWebsiteSource — extracts structured data from a gym's official website.
 * Handles: JSON-LD LocalBusiness schema, OpenGraph, contact patterns,
 * pricing pages, class schedule tables, and amenity keyword scanning.
 */

const BaseSourceScraper = require('./BaseSourceScraper');
const { scrapeWebsitePhotos } = require('../websiteScraper');
const logger = require('../../utils/logger');

// Regex patterns for contact extraction
const PHONE_RE   = /(?:\+91[\s-]?)?(?:\d{5}[\s-]?\d{5}|\d{4}[\s-]?\d{6}|[0-9]{10}|\([0-9]{2,4}\)\s*[0-9\s-]{7,})/g;
const EMAIL_RE   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PRICE_RE   = /(?:₹|INR|Rs\.?)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;

// Keywords that appear on pricing pages
const PRICING_PAGE_HINTS = ['price', 'pricing', 'membership', 'plan', 'fee', 'rate', 'join', 'tariff'];
// Keywords that appear on class schedule pages
const SCHEDULE_PAGE_HINTS = ['schedule', 'timetable', 'class', 'session', 'batch', 'timing'];
// Amenity keywords to scan from body text
const AMENITY_KEYWORDS = {
  'air-conditioning': ['air conditioning', 'ac', 'air-conditioned'],
  'parking':          ['parking', 'car park', 'bike stand'],
  'locker-rooms':     ['locker', 'locker room', 'changing room'],
  'showers':          ['shower', 'bathrooms'],
  'sauna':            ['sauna', 'steam room', 'steam bath'],
  'swimming-pool-amenity': ['swimming pool', 'pool'],
  'wifi':             ['wifi', 'wi-fi', 'internet'],
  'personal-trainer': ['personal trainer', 'personal training', 'one-on-one'],
  'group-classes':    ['group class', 'group fitness', 'group session'],
  'juice-bar':        ['juice bar', 'protein bar', 'cafe', 'cafeteria'],
  'women-only':       ["ladies only", "women only", "women's section", "ladies section"],
  '24-7-access':      ['24/7', '24 hours', 'round the clock'],
  'free-weights':     ['free weights', 'dumbbells', 'barbells'],
  'cardio-machines':  ['treadmill', 'elliptical', 'cardio machines', 'cycle'],
  'strength-machines':['weight machines', 'strength machines', 'cable machines'],
};

class OfficialWebsiteSource extends BaseSourceScraper {
  constructor() {
    super();
    this.sourceId = 'official_website';
  }

  canHandleUrl(url) {
    // Not a major platform — handle any non-platform URL as potential official website
    const platforms = /google\.com|justdial|sulekha|yelp\.com|facebook\.com|instagram\.com|openstreetmap/i;
    return !platforms.test(url);
  }

  async scrapeByUrl(url) {
    await this._launchBrowser();
    const page = await this._newPage();

    try {
      const data = await this._scrapeHomepage(page, url);
      if (!data) return null;

      // Try to find and scrape pricing page
      const pricingData = await this._tryPricingPage(page, url, data.allLinks || []);
      if (pricingData) {
        data.priceLevel = pricingData.priceLevel;
        data._pricingHints = pricingData.pricingHints;
      }

      // Try to find and scrape class schedule
      const scheduleData = await this._trySchedulePage(page, url, data.allLinks || []);
      if (scheduleData) {
        data.offerings = [...(data.offerings || []), ...scheduleData.classNames];
        data.hasClasses = scheduleData.classNames.length > 0;
      }

      return data;
    } finally {
      await this._closeBrowser();
    }
  }

  async enrichSpace(space, stages = ['all']) {
    const url = space.contact?.website;
    if (!url) return {};
    return this.scrapeByUrl(url);
  }

  async _scrapeHomepage(page, url) {
    this._log('info', `Website: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(1000, 2000);

      const data = await page.evaluate(() => {
        const result = {};

        // ── JSON-LD LocalBusiness extraction ─────────────────────────────
        const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const s of ldScripts) {
          try {
            const ld = JSON.parse(s.textContent);
            const schemas = Array.isArray(ld) ? ld : [ld, ...(ld['@graph'] || [])];
            for (const schema of schemas) {
              const t = schema['@type'] || '';
              if (!/(LocalBusiness|GymOrFitnessCenter|SportsClub|HealthClub|Organization)/i.test(t)) continue;
              result.name        = result.name        || schema.name;
              result.description = result.description || schema.description;
              result.phone       = result.phone       || schema.telephone;
              result.email       = result.email       || schema.email;
              result.website     = result.website     || schema.url;
              result.address     = result.address     || (
                schema.address
                  ? [schema.address.streetAddress, schema.address.addressLocality,
                     schema.address.addressRegion, schema.address.postalCode]
                    .filter(Boolean).join(', ')
                  : null
              );
              result.lat = result.lat || schema.geo?.latitude  || null;
              result.lng = result.lng || schema.geo?.longitude || null;
              if (schema.openingHoursSpecification) result._schemaHours = schema.openingHoursSpecification;
              if (schema.priceRange) result._priceRange = schema.priceRange;
              if (schema.amenityFeature) result._schemaAmenities = schema.amenityFeature.map(a => a.name);
            }
          } catch (_) {}
        }

        // ── OpenGraph fallback ────────────────────────────────────────────
        const og = sel => document.querySelector(`meta[property="${sel}"]`)?.content || null;
        result.name        = result.name        || og('og:site_name') || document.title || null;
        result.description = result.description || og('og:description')
          || document.querySelector('meta[name="description"]')?.content || null;

        // ── All internal links (for pricing/schedule page discovery) ─────
        result.allLinks = [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => h && !h.startsWith('mailto:') && !h.startsWith('tel:'))
          .slice(0, 80);

        // ── Images (for photo capture) ────────────────────────────────────
        result.photos = [...document.querySelectorAll('img[src]')]
          .map(img => img.src)
          .filter(s => /\.(jpg|jpeg|png|webp)/i.test(s))
          .slice(0, 30);

        // ── Page body text for keyword extraction ─────────────────────────
        result.bodyText = document.body?.innerText?.slice(0, 8000) || '';

        return result;
      });

      if (!data) return null;

      // ── Extract amenities from body text ──────────────────────────────
      data.amenities = { raw: this._extractAmenities(data.bodyText) };
      if (data._schemaAmenities) {
        data.amenities.raw.push(...data._schemaAmenities);
      }

      // ── Extract phones/emails from body text ──────────────────────────
      if (!data.phone) {
        const phones = data.bodyText.match(PHONE_RE);
        data.phone = phones?.[0]?.replace(/[^0-9+]/g, '') || null;
      }
      if (!data.email) {
        const emails = data.bodyText.match(EMAIL_RE);
        data.email = emails?.[0] || null;
      }

      // ── Parse schema hours ────────────────────────────────────────────
      if (data._schemaHours) {
        data.openingHours = this._parseSchemaHours(data._schemaHours);
      }

      return this._normalize(data, url);
    } catch (err) {
      this._log('warn', `Homepage scrape error: ${err.message}`);
      return null;
    }
  }

  async _tryPricingPage(page, baseUrl, links) {
    const pricingUrl = links.find(link =>
      PRICING_PAGE_HINTS.some(hint => link.toLowerCase().includes(hint))
      && this._isSameDomain(link, baseUrl)
    );
    if (!pricingUrl || pricingUrl === baseUrl) return null;

    try {
      await page.goto(pricingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.sleep(800, 1200);

      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || '');
      const priceMatches = [...text.matchAll(PRICE_RE)];
      const prices = priceMatches.map(m => parseFloat(m[1].replace(/,/g, '')));

      if (!prices.length) return null;

      const maxPrice = Math.max(...prices);
      let priceLevel = 'mid';
      if (maxPrice < 1500)  priceLevel = 'budget';
      if (maxPrice > 5000)  priceLevel = 'premium';

      return { priceLevel, pricingHints: prices };
    } catch (_) {
      return null;
    }
  }

  async _trySchedulePage(page, baseUrl, links) {
    const scheduleUrl = links.find(link =>
      SCHEDULE_PAGE_HINTS.some(hint => link.toLowerCase().includes(hint))
      && this._isSameDomain(link, baseUrl)
    );
    if (!scheduleUrl || scheduleUrl === baseUrl) return null;

    try {
      await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.sleep(800, 1200);

      const classNames = await page.evaluate(() => {
        const names = new Set();
        // Look for table headers / class title elements
        document.querySelectorAll('td, th, .class-name, .session-name, h3, h4').forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length >= 3 && text.length <= 60) names.add(text);
        });
        return [...names].slice(0, 30);
      });

      return { classNames: classNames.filter(n => /yoga|zumba|aerobics|hiit|pilates|dance|crossfit|boxing|kickboxing|stretching|spinning|cycling/i.test(n)) };
    } catch (_) {
      return null;
    }
  }

  _extractAmenities(bodyText) {
    const text  = bodyText.toLowerCase();
    const found = [];
    for (const [slug, keywords] of Object.entries(AMENITY_KEYWORDS)) {
      if (keywords.some(kw => text.includes(kw))) found.push(slug);
    }
    return found;
  }

  _parseSchemaHours(specs) {
    const DAY_MAP = {
      Monday: 'Monday', Tuesday: 'Tuesday', Wednesday: 'Wednesday',
      Thursday: 'Thursday', Friday: 'Friday', Saturday: 'Saturday', Sunday: 'Sunday',
    };
    return (Array.isArray(specs) ? specs : [specs]).map(spec => ({
      day:      DAY_MAP[spec.dayOfWeek?.replace?.('http://schema.org/', '')] || spec.dayOfWeek || '',
      open:     spec.opens  || '',
      close:    spec.closes || '',
      isOpen24: spec.opens === '00:00' && spec.closes === '23:59',
      isClosed: false,
    }));
  }

  _isSameDomain(url, base) {
    try {
      return new URL(url).hostname === new URL(base).hostname;
    } catch (_) {
      return false;
    }
  }

  _normalize(raw, sourceUrl) {
    return {
      sourceId:     this.sourceId,
      name:         raw.name         || null,
      address:      raw.address      || null,
      lat:          raw.lat          ? parseFloat(raw.lat)  : null,
      lng:          raw.lng          ? parseFloat(raw.lng)  : null,
      contact: {
        phone:   raw.phone   ? String(raw.phone).replace(/[^0-9+]/g, '') : null,
        website: raw.website || sourceUrl,
        email:   raw.email   || null,
      },
      description:    raw.description    || null,
      priceLevel:     raw.priceLevel     || null,
      openingHours:   raw.openingHours   || [],
      amenities:      raw.amenities      || { raw: [] },
      offerings:      raw.offerings      || [],
      hasClasses:     raw.hasClasses     || false,
      photos:         raw.photos         || [],
      rawPhotoUrls:   raw.photos         || [],
      reviews:        [],
      sourceUrl:      sourceUrl,
      confidence:     0.75,
    };
  }
}

module.exports = new OfficialWebsiteSource();
