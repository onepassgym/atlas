'use strict';
/**
 * JustDialSource — scrapes JustDial.com India fitness listings.
 * JustDial is India's largest business directory: 50M+ listings.
 * URL pattern: https://www.justdial.com/{city}/{category}/
 */

const BaseSourceScraper = require('./BaseSourceScraper');
const logger = require('../../utils/logger');

// JustDial category search slugs mapped to our fitness categories
const JD_CATEGORY_QUERIES = [
  'Gyms-and-Fitness-Centers',
  'Yoga-Classes',
  'Pilates-Classes',
  'CrossFit-Gyms',
  'Martial-Arts-Classes',
  'Boxing-Clubs',
  'Dance-Classes',
  'Swimming-Pools',
  'Personal-Trainers',
  'Zumba-Classes',
  'HIIT-Training-Centers',
  'Physiotherapy-Centers',
];

class JustDialSource extends BaseSourceScraper {
  constructor() {
    super();
    this.sourceId = 'justdial';
  }

  canHandleUrl(url) {
    return /justdial\.com/i.test(url);
  }

  async searchByArea(area, categories = []) {
    const cats = categories.length > 0 ? categories : JD_CATEGORY_QUERIES;
    const results = [];

    await this._launchBrowser();
    const page = await this._newPage();

    try {
      for (const cat of cats.slice(0, 5)) { // cap at 5 categories per run
        const citySlug = area.replace(/,.*$/, '').trim().replace(/\s+/g, '-');
        const url = `https://www.justdial.com/${citySlug}/${cat}/nct-${citySlug}`;
        try {
          const found = await this._scrapeListingPage(page, url);
          results.push(...found);
          await this.sleep(2000, 4000);
        } catch (err) {
          this._log('warn', `Area search failed for ${cat}: ${err.message}`);
        }
      }
    } finally {
      await this._closeBrowser();
    }

    return results;
  }

  async searchByName(name, location = null, categories = []) {
    await this._launchBrowser();
    const page = await this._newPage();

    try {
      const city = (location || 'India').replace(/,.*$/, '').trim().replace(/\s+/g, '-');
      const query = encodeURIComponent(name);
      const url = `https://www.justdial.com/${city}/${query}`;
      const results = await this._scrapeListingPage(page, url);
      return results.filter(r => {
        const n = (r.name || '').toLowerCase();
        return name.toLowerCase().split(' ').some(w => w.length > 2 && n.includes(w));
      });
    } finally {
      await this._closeBrowser();
    }
  }

  async scrapeByUrl(url) {
    if (!this.canHandleUrl(url)) return null;
    await this._launchBrowser();
    const page = await this._newPage();
    try {
      return await this._scrapeDetailPage(page, url);
    } finally {
      await this._closeBrowser();
    }
  }

  async _scrapeListingPage(page, url) {
    this._log('info', `Listing: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(2000, 3000);

      // JustDial lazy-loads results — scroll to trigger
      await page.evaluate(() => window.scrollTo(0, 600));
      await this.sleep(1000, 1500);

      const items = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('[data-name]').forEach(el => {
          const name      = el.getAttribute('data-name');
          const address   = el.getAttribute('data-address');
          const phone     = el.getAttribute('data-phone');
          const rating    = parseFloat(el.getAttribute('data-rating') || '0') || null;
          const reviews   = parseInt(el.getAttribute('data-reviews') || '0', 10) || 0;
          const category  = el.getAttribute('data-cat') || '';
          const detailUrl = el.querySelector('a[href]')?.getAttribute('href') || '';
          const website   = el.getAttribute('data-url') || null;
          if (name) results.push({ name, address, phone, rating, reviews, category, detailUrl, website });
        });
        return results;
      });

      return items.map(i => this._normalize(i, url));
    } catch (err) {
      this._log('warn', `Listing page error: ${err.message}`);
      return [];
    }
  }

  async _scrapeDetailPage(page, url) {
    this._log('info', `Detail: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(1500, 2500);

      const data = await page.evaluate(() => {
        const get = sel => document.querySelector(sel)?.textContent?.trim() || null;
        const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

        const name      = get('h1.jd_title') || get('h1') || get('.fn');
        const address   = get('.address_txt') || get('.jd_address');
        const phone     = get('.mobilesv') || get('.callnow') || getAttr('[data-phone]', 'data-phone');
        const rating    = parseFloat(get('.green-box') || '0') || null;
        const reviews   = parseInt((get('.ratingCount') || '0').replace(/[^0-9]/g, ''), 10) || 0;
        const website   = getAttr('a.websiteurl', 'href');
        const hours     = get('.fn.timing') || null;
        const category  = get('.catname') || '';
        const desc      = get('.jd_desc') || null;

        return { name, address, phone, rating, reviews, website, hours, category, desc };
      });

      if (!data.name) return null;

      const result = this._normalize({ ...data, detailUrl: url }, url);
      if (data.hours) result._rawHours = data.hours;
      return result;
    } catch (err) {
      this._log('warn', `Detail page error: ${err.message}`);
      return null;
    }
  }

  _normalize(raw, sourceUrl) {
    const phone = raw.phone ? raw.phone.replace(/[^0-9+]/g, '') : null;
    return {
      sourceId:     this.sourceId,
      name:         raw.name || null,
      address:      raw.address || null,
      city:         this._extractCity(raw.address),
      contact: {
        phone:   phone || null,
        website: raw.website || null,
        email:   null,
      },
      rating:       raw.rating   || null,
      totalReviews: raw.reviews  || 0,
      categories:   raw.category ? [raw.category] : [],
      description:  raw.desc     || null,
      photos:       [],
      rawPhotoUrls: [],
      reviews:      [],
      sourceUrl:    raw.detailUrl || sourceUrl || null,
      confidence:   0.65,
    };
  }

  _extractCity(address) {
    if (!address) return null;
    const parts = address.split(',');
    return parts.length >= 2 ? parts[parts.length - 2].trim() : null;
  }
}

module.exports = new JustDialSource();
