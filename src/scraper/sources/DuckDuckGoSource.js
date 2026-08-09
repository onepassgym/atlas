'use strict';
const axios         = require('axios');
const BaseSourceScraper = require('./BaseSourceScraper');
const rateLimiter   = require('../../services/rateLimiter');
const logger        = require('../../utils/logger');

// Domains that are never considered an official gym website
const BLOCKLIST = new Set([
  'google.com', 'google.co.in', 'maps.google.com',
  'justdial.com', 'sulekha.com', 'indiamart.com', 'tradeindia.com',
  'yelp.com', 'tripadvisor.com', 'zomato.com', 'practo.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'youtube.com',
  'wikipedia.org', 'wikidata.org', 'linkedin.com',
  'amazon.in', 'flipkart.com', 'olx.in',
  'magicbricks.com', '99acres.com', 'commonfloor.com',
]);

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
}

function isDomainBlocked(domain) {
  if (!domain) return true;
  return BLOCKLIST.has(domain) || [...BLOCKLIST].some(b => domain.endsWith('.' + b));
}

class DuckDuckGoSource extends BaseSourceScraper {
  constructor() {
    super();
    this.sourceId = 'duckduckgo';
  }

  canHandleUrl() { return false; }
  async searchByName() { return []; }
  async searchByArea() { return []; }
  async scrapeByUrl() { return null; }

  /**
   * Find the most likely official website domain for a named venue.
   * Uses DuckDuckGo HTML-lite endpoint (no JS, no API key).
   * Returns { url, domain, confidence } or null.
   */
  async findOfficialDomain(name, city) {
    await rateLimiter.acquire('duckduckgo');

    const q = `"${name}" "${city}" official website -justdial -yelp -facebook -instagram`;

    try {
      const resp = await axios.get('https://duckduckgo.com/html/', {
        params: { q, kl: 'in-en', kp: '-2' },
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml',
          'Accept-Language': 'en-IN,en;q=0.9',
          'Referer':         'https://duckduckgo.com/',
        },
        timeout: 12000,
      });

      const html = typeof resp.data === 'string' ? resp.data : '';
      const found = [];

      // Extract href URLs from result links
      const hrefRe = /href="(https?:\/\/[^"&]+)"/g;
      let m;
      while ((m = hrefRe.exec(html)) !== null) {
        let rawUrl;
        try { rawUrl = decodeURIComponent(m[1]); } catch (_) { rawUrl = m[1]; }
        const domain = extractDomain(rawUrl);
        if (domain && !isDomainBlocked(domain) && !found.includes(domain)) {
          found.push(domain);
          if (found.length >= 3) break;
        }
      }

      if (!found.length) return null;

      return {
        url:        `https://${found[0]}`,
        domain:     found[0],
        confidence: found.length === 1 ? 0.70 : 0.55,
      };
    } catch (err) {
      logger.debug(`[DuckDuckGoSource] findOfficialDomain failed for "${name}" / "${city}": ${err.message}`);
      return null;
    }
  }
}

module.exports = new DuckDuckGoSource();
