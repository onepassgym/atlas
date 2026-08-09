'use strict';
/**
 * BaseSourceScraper — abstract interface for all fitness data source adapters.
 *
 * Every source adapter (GoogleMaps, JustDial, OSM, Website, Yelp, etc.) MUST:
 *   - Set this.sourceId (string)
 *   - Implement searchByName(name, location?, categories?)  → RawSpaceResult[]
 *   - Implement searchByArea(area, categories?)             → RawSpaceResult[]
 *   - Implement scrapeByUrl(url)                           → RawSpaceResult | null
 *   - Implement canHandleUrl(url)                          → boolean
 *   - Implement enrichSpace(space, stages)                 → Partial<RawSpaceResult>
 *
 * RawSpaceResult shape:
 * {
 *   sourceId:        string,               // which adapter produced this
 *   name:            string,
 *   placeId?:        string,               // source-specific ID
 *   googleMapsUrl?:  string,
 *   address?:        string,
 *   city?:           string,
 *   areaName?:       string,
 *   state?:          string,
 *   pincode?:        string,
 *   country?:        string,
 *   lat?:            number,
 *   lng?:            number,
 *   rating?:         number,
 *   totalReviews?:   number,
 *   contact?:        { phone, website, email, instagram, facebook },
 *   openingHours?:   [{ day, open, close, isOpen24, isClosed }],
 *   description?:    string,
 *   categories?:     string[],             // raw category labels
 *   amenities?:      { raw: string[] },
 *   highlights?:     string[],
 *   offerings?:      string[],
 *   priceLevel?:     string,
 *   photos?:         string[],             // raw photo URLs
 *   reviews?:        RawReview[],
 *   rawPhotoUrls?:   string[],
 *   sourceUrl?:      string,               // canonical URL for this source
 *   confidence?:     number,               // 0-1 how confident this result is
 * }
 */

const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const cfg = require('../../../config');
const logger = require('../../utils/logger');

chromium.use(stealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

class BaseSourceScraper {
  constructor() {
    if (new.target === BaseSourceScraper) {
      throw new Error('BaseSourceScraper is abstract — instantiate a subclass');
    }
    this.sourceId = 'base'; // must be overridden
    this._browser = null;
    this._ctx     = null;
  }

  // ── Browser lifecycle ────────────────────────────────────────────────────

  async _launchBrowser(extraArgs = []) {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    this._browser = await chromium.launch({
      headless: cfg.scraper.headless,
      executablePath,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-first-run', '--no-zygote',
        '--disable-background-networking',
        '--lang=en-US',
        ...extraArgs,
      ],
    });

    const proxyList = cfg.sources?.proxyList || [];
    const proxyConfig = proxyList.length > 0 ? this._buildProxy(pick(proxyList)) : {};

    this._ctx = await this._browser.newContext({
      userAgent:  pick(USER_AGENTS),
      locale:     'en-US',
      viewport:   pick(VIEWPORTS),
      ...proxyConfig,
    });

    // Block heavy resources — only need DOM
    await this._ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(t)) return route.abort();
      return route.continue();
    });

    return this._ctx;
  }

  _buildProxy(proxyStr) {
    const parts = proxyStr.split(':');
    if (parts.length < 2) return {};
    const server = `http://${parts[0]}:${parts[1]}`;
    if (parts.length === 4) {
      return { proxy: { server, username: parts[2], password: parts[3] } };
    }
    return { proxy: { server } };
  }

  async _newPage() {
    if (!this._ctx) throw new Error(`${this.sourceId}: browser not launched`);
    return this._ctx.newPage();
  }

  async _closeBrowser() {
    try { await this._browser?.close(); } catch (_) {}
    this._browser = null;
    this._ctx     = null;
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  sleep(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
  }

  _log(level, msg) {
    logger[level](`[${this.sourceId}] ${msg}`);
  }

  // ── Interface — subclasses must implement ────────────────────────────────

  /** Search by name (and optional location string). Returns array of raw results. */
  // eslint-disable-next-line no-unused-vars
  async searchByName(name, location = null, categories = []) {
    throw new Error(`${this.sourceId}.searchByName() not implemented`);
  }

  /** Search all fitness spaces in an area/city. Returns array of raw results. */
  // eslint-disable-next-line no-unused-vars
  async searchByArea(area, categories = []) {
    throw new Error(`${this.sourceId}.searchByArea() not implemented`);
  }

  /** Scrape a single space from a direct URL. Returns one raw result or null. */
  // eslint-disable-next-line no-unused-vars
  async scrapeByUrl(url) {
    throw new Error(`${this.sourceId}.scrapeByUrl() not implemented`);
  }

  /** Returns true if this adapter can handle the given URL. */
  // eslint-disable-next-line no-unused-vars
  canHandleUrl(url) {
    return false;
  }

  /**
   * Enrich an existing space document with additional data from this source.
   * Called during enrichment pipeline stages.
   * @param {Object} space  — existing Space mongoose doc (lean)
   * @param {string[]} stages — which aspects to enrich: ['reviews','photos','contact','hours','amenities']
   * @returns {Partial<RawSpaceResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async enrichSpace(space, stages = ['all']) {
    return {};
  }
}

module.exports = BaseSourceScraper;
