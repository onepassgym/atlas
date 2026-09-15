'use strict';
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const cfg    = require('../../config');
const logger = require('../utils/logger');
const { scrapeWebsitePhotos } = require('./websiteScraper');

// ── Activate stealth anti-detection ──────────────────────────────────────────
chromium.use(stealthPlugin());

// Phase 6b: Trimmed from 16 →10 categories — removed low-yield entries
// that heavily overlap with 'space' and 'fitness center':
// dropped: functional training space, strength training space, health club,
//          sports club, zumba class, cycling studio
const FITNESS_CATEGORIES = [
  'space',
  'fitness center',
  'yoga studio',
  'crossfit',
  'pilates studio',
  'martial arts space',
  'boxing space',
  'dance fitness studio',
  'personal training studio',
  'swimming club',
];

// ── User-Agent rotation pool ─────────────────────────────────────────────────
// Last updated: 2026-09 — Chrome 136, Firefox 138, Edge 136, Safari 18.x
// Review and refresh every 6 months to avoid fingerprint-based blocking.
const USER_AGENTS = [
  // Chrome 136 — Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.6778.139 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  // Chrome 136 — macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  // Chrome 136 — Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  // Firefox 138
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0',
  // Edge 136
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
  // Safari 18.x — macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
  // Chrome 134 — slightly older for diversity
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
];

// ── Viewport rotation pool ───────────────────────────────────────────────────
// Realistic desktop resolutions — makes each session look like a different device
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
];

// ── Timezone rotation pool ───────────────────────────────────────────────────
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
];

// ── Accept-Language rotation ─────────────────────────────────────────────────
const ACCEPT_LANGS = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.9,es;q=0.8',
  'en-GB,en;q=0.9,en-US;q=0.8',
  'en-US,en;q=0.9,de;q=0.7',
  'en-US,en;q=0.9,fr;q=0.8',
  'en,en-US;q=0.9',
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getRandomUA() { return pickRandom(USER_AGENTS); }

function sleep(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

/**
 * Normalize a Google Maps place URL: keep the place name and coordinate anchor
 * (/@lat,lng,zoom) but strip query params (?...) and the /data= segment.
 * The coordinate anchor is critical — without it, Google may redirect to a
 * generic search or a different place entirely.
 */
function normalizeMapUrl(href) {
  if (!href) return null;
  // Strip query params
  let url = href.split('?')[0];
  // Strip /data=... segment (internal Google routing data)
  url = url.replace(/\/data=[^/]*$/, '');
  return url;
}

// ── Browser pool ──────────────────────────────────────────────────────────────

class BrowserManager {
  constructor() { this.browser = null; this.ctx = null; }

  async launch() {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    this.browser = await chromium.launch({
      headless: cfg.scraper.headless,
      executablePath,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-first-run', '--no-zygote',
        '--disable-background-networking',
        '--disable-default-apps',
        '--lang=en-US',
      ],
    });

    // Randomize fingerprint per session — each batch looks like a different user
    const viewport = pickRandom(VIEWPORTS);
    const tz       = pickRandom(TIMEZONES);
    const lang     = pickRandom(ACCEPT_LANGS);

    this.ctx = await this.browser.newContext({
      userAgent:   getRandomUA(),
      locale:      'en-US',
      timezoneId:  tz,
      viewport,
      extraHTTPHeaders: { 'Accept-Language': lang },
    });

    logger.info(`  🎭 Browser fingerprint: ${viewport.width}×${viewport.height}, tz:${tz}`);

    // ── Phase 1a: Aggressive resource blocking ────────────────────────────────
    // Block images, stylesheets, fonts, media — we only need DOM text content.
    // Also block tracking/analytics domains to reduce noise and page weight.
    await this.ctx.route('**/*', (route) => {
      const type = route.request().resourceType();
      const blocked = ['image', 'stylesheet', 'font', 'media', 'other'];
      if (blocked.includes(type)) return route.abort();
      const url = route.request().url();
      if (/google-analytics|doubleclick|googlesyndication|facebook\.net|hotjar|clarity\.ms/.test(url))
        return route.abort();
      return route.continue();
    });

    return this.ctx;
  }

  async newPage() { return this.ctx.newPage(); }

  async close() {
    try { await this.browser?.close(); } catch (_) {}
    this.browser = null; this.ctx = null;
  }
}

// ── Google block / CAPTCHA detection ─────────────────────────────────────────
// Returns true if Google served a CAPTCHA, consent wall, or unusual-traffic page
// instead of actual Maps content. The worker should back off when this triggers.

async function isBlocked(page) {
  try {
    const blocked = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      // CAPTCHA / unusual traffic page
      if (/unusual traffic|captcha|are you a robot|automated queries/i.test(body)) return 'captcha';
      // Google consent wall that won't dismiss
      if (/before you continue|consent\.google/i.test(window.location.href)) return 'consent';
      // Completely empty page (blocked silently)
      if (document.querySelectorAll('a[href*="/maps/place/"]').length === 0 &&
          !document.querySelector('h1') &&
          body.length < 200) return 'empty';
      return false;
    });
    return blocked;
  } catch (_) {
    return false;
  }
}

// ── Search: collect all place URLs for a query ───────────────────────────────

const MAX_SEARCH_RETRIES = 2; // max retry attempts after a Google block per category search

async function searchSpacesInCity(page, cityName, category) {
  const query = category
    ? `${category} in ${cityName}`
    : cityName; // direct space name search

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

  for (let attempt = 1; attempt <= MAX_SEARCH_RETRIES + 1; attempt++) {
    logger.info(`  🔍 Searching: "${query}"${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);

    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.scraper.timeout });
      } catch (_) {
        await page.goto(url, { waitUntil: 'commit', timeout: cfg.scraper.timeout });
      }
    } catch (navErr) {
      logger.warn(`  ⚠️ Navigation failed for "${query}" (attempt ${attempt}): ${navErr.message}`);
      if (attempt > MAX_SEARCH_RETRIES) return [];
      await sleep(10000, 20000);
      continue;
    }

    // Optimized delay — enough for Google to render results
    await sleep(2000, 3000);

    // Check for Google block/CAPTCHA immediately
    const blockReason = await isBlocked(page);
    if (blockReason) {
      if (attempt > MAX_SEARCH_RETRIES) {
        logger.warn(`  🚫 Google blocked "${query}" after ${attempt} attempt(s) — giving up`);
        return [];
      }
      // Exponential-ish backoff: 15–30s on first retry, 30–60s on second
      const backoffMin = 15000 * attempt;
      const backoffMax = 30000 * attempt;
      logger.warn(`  🚫 Google blocked "${query}" (reason: ${blockReason}, attempt ${attempt}/${MAX_SEARCH_RETRIES + 1}) — backing off ${(backoffMin/1000).toFixed(0)}–${(backoffMax/1000).toFixed(0)}s`);
      await sleep(backoffMin, backoffMax);
      continue;
    }

    // Dismiss cookie banner if present
    for (const sel of ['button:has-text("Accept all")', 'button:has-text("Agree")', 'button[aria-label="Accept all"]']) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          await sleep(600, 1000);
          break;
        }
      } catch (_) {}
    }

    const spaceUrls  = new Set();
    let   noNewFor = 0;
    let   lastSize = 0;

    while (true) {
      // Grab all place links
      const links = await page.locator('a[href*="/maps/place/"]').all();
      for (const a of links) {
        try {
          const href = await a.getAttribute('href');
          if (href) spaceUrls.add(normalizeMapUrl(href));
        } catch (_) {}
      }

      // End of list?
      const ended = await page.locator('text="You\'ve reached the end of the list."').isVisible({ timeout: 500 }).catch(() => false);
      if (ended) break;

      // Scroll the results panel
      const panel = page.locator('div[role="feed"]').first();
      try {
        await panel.evaluate(el => el.scrollBy(0, 1200));
      } catch (_) {
        await page.mouse.wheel(0, 1200);
      }
      // Optimized scroll delay
      await sleep(1200, 2000);

      if (spaceUrls.size === lastSize) { if (++noNewFor >= 5) break; }
      else noNewFor = 0;
      lastSize = spaceUrls.size;
    }

    // ── Direct place page detection ──────────────────────────────────────────
    // Google sometimes redirects exact-name queries directly to the space's
    // own detail page instead of showing a list/feed. In that case the scroll
    // loop above finds zero feed links and spaceUrls stays empty.
    // Detect this by checking if we are now on a /maps/place/ URL and, if so,
    // wait for the page to fully resolve (Google Maps appends coordinates and
    // CID to the URL after the JS loads), then capture the final settled URL
    // so that scrapeSpaceDetail can navigate to a proper place detail page.
    if (spaceUrls.size === 0) {
      try {
        const currentUrl = page.url();
        if (/\/maps\/place\//i.test(currentUrl)) {
          // Wait for the URL to settle — Google Maps rewrites it after JS hydration
          // (e.g. /maps/place/Name → /maps/place/Name/@lat,lng,17z/data=...)
          await sleep(3000, 4000);
          const settledUrl = page.url();
          // Only use it if the URL is now a fully-resolved place page with coords or CID
          if (/\/maps\/place\/.+\/@-?\d+\.\d+/i.test(settledUrl) ||
              /\/maps\/place\/.+\/data=/i.test(settledUrl)) {
            const canonicalUrl = settledUrl.split('?')[0].split('/@')[0];
            // Re-add the coordinates segment so scrapeSpaceDetail lands on the right place
            const atPart = settledUrl.match(/\/@([^/]+)/)?.[0] || '';
            const dataPart = settledUrl.match(/\/data=[^?]*/)?.[0] || '';
            const fullUrl = canonicalUrl + atPart + dataPart;
            spaceUrls.add(fullUrl);
            logger.info(`  📍 Direct place redirect detected — captured: ${fullUrl.slice(-80)}`);
          } else {
            logger.info(`  📍 Direct place redirect detected but URL did not fully resolve: ${settledUrl.slice(-80)}`);
          }
        }
      } catch (_) {}
    }

    logger.info(`  ✅ Found ${spaceUrls.size} URLs for "${query}"`);
    return [...spaceUrls];
  }

  // Safety net — should not reach here
  return [];
}

async function searchSpacesInGrid(page, lat, lng, zoom, category) {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(category)}/@${lat},${lng},${zoom}z/data=!3m1!4b1`;

  for (let attempt = 1; attempt <= MAX_SEARCH_RETRIES + 1; attempt++) {
    logger.info(`  🔍 Grid Searching: "${category}" at [${lat}, ${lng}] (zoom: ${zoom})${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);

    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.scraper.timeout });
      } catch (_) {
        await page.goto(url, { waitUntil: 'commit', timeout: cfg.scraper.timeout });
      }
    } catch (navErr) {
      logger.warn(`  ⚠️ Navigation failed for grid [${lat}, ${lng}] (attempt ${attempt}): ${navErr.message}`);
      if (attempt > MAX_SEARCH_RETRIES) return [];
      await sleep(10000, 20000);
      continue;
    }

    await sleep(2000, 3000);

    const blockReason = await isBlocked(page);
    if (blockReason) {
      if (attempt > MAX_SEARCH_RETRIES) {
        logger.warn(`  🚫 Google blocked grid [${lat}, ${lng}] after ${attempt} attempt(s) — giving up`);
        return [];
      }
      const backoffMin = 15000 * attempt;
      const backoffMax = 30000 * attempt;
      logger.warn(`  🚫 Google blocked grid [${lat}, ${lng}] (reason: ${blockReason}, attempt ${attempt}/${MAX_SEARCH_RETRIES + 1}) — backing off`);
      await sleep(backoffMin, backoffMax);
      continue;
    }

    for (const sel of ['button:has-text("Accept all")', 'button:has-text("Agree")', 'button[aria-label="Accept all"]']) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          await sleep(600, 1000);
          break;
        }
      } catch (_) {}
    }

    const spaceUrls  = new Set();
    let   noNewFor = 0;
    let   lastSize = 0;

    while (true) {
      const links = await page.locator('a[href*="/maps/place/"]').all();
      for (const a of links) {
        try {
          const href = await a.getAttribute('href');
          if (href) spaceUrls.add(normalizeMapUrl(href));
        } catch (_) {}
      }

      const ended = await page.locator('text="You\'ve reached the end of the list."').isVisible({ timeout: 500 }).catch(() => false);
      if (ended) break;

      const panel = page.locator('div[role="feed"]').first();
      try {
        await panel.evaluate(el => el.scrollBy(0, 1200));
      } catch (_) {
        await page.mouse.wheel(0, 1200);
      }
      await sleep(1200, 2000);

      if (spaceUrls.size === lastSize) { if (++noNewFor >= 5) break; }
      else noNewFor = 0;
      lastSize = spaceUrls.size;
    }

    logger.info(`  ✅ Found ${spaceUrls.size} URLs for grid [${lat}, ${lng}]`);
    return [...spaceUrls];
  }

  return [];
}

// ── Detail: scrape full space data from a place page ───────────────────────────
// Phase 4: mode controls scrape depth
//   'fast'     → core data only, no reviews/photos tab navigation
//   'standard' → core + about tab + 30 reviews + 20 photos (default)
//   'deep'     → core + about tab + 150 reviews + 80 photos

async function scrapeSpaceDetail(page, url, mode = 'standard', ctx = null) {
  // enrichment mode: 500 reviews, 500 photos (URL capture only)
  const maxReviews = mode === 'deep' ? 150 : mode === 'enrichment' ? cfg.scraper.enrichMaxReviews : (mode === 'fast' ? 0 : cfg.scraper.maxReviews);
  const maxPhotos  = mode === 'deep' ? 80  : mode === 'enrichment' ? cfg.scraper.enrichMaxPhotos  : (mode === 'fast' ? 0 : cfg.scraper.maxPhotos);

  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.scraper.timeout });
    } catch (_) {
      // Fallback: 'commit' fires as soon as any response is received — catches slow pages
      await page.goto(url, { waitUntil: 'commit', timeout: cfg.scraper.timeout });
    }
    // Optimized page load delay
    await sleep(1800, 2800);
  } catch (err) {
    throw new Error(`Navigation failed: ${err.message}`);
  }

  // Check for Google block/CAPTCHA on detail page
  const blockReason = await isBlocked(page);
  if (blockReason) {
    logger.warn(`  🚫 Google blocked detail page (reason: ${blockReason}) — backing off`);
    await sleep(15000, 30000);
    throw new Error(`Google blocked: ${blockReason}`);
  }

  // ── Core data from DOM ───────────────────────────────────────────────────
  // Uses multi-selector fallback chains for resilience against Google Maps
  // DOM changes. Each field tries primary → secondary → aria-label-based selectors.
  const core = await page.evaluate(() => {
    // Fallback helpers: try selectors in order, return first truthy result
    function tryText(...selectors) {
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return null;
    }
    function tryAttr(attr, ...selectors) {
      for (const s of selectors) {
        const el = document.querySelector(s);
        const val = el?.getAttribute(attr);
        if (val) return val;
      }
      return null;
    }
    function tryAll(...selectors) {
      for (const s of selectors) {
        const els = [...document.querySelectorAll(s)];
        if (els.length > 0) return els;
      }
      return [];
    }

    // Name — primary: h1.DUwDvf, secondary: any h1, tertiary: data-attrid
    const name = tryText('h1.DUwDvf', 'h1.fontHeadlineLarge', 'h1', '[data-attrid="title"]');

    // Rating — primary: .F7nice hidden span, secondary: .MW4etd, tertiary: role=img star
    const ratingRaw = tryText('.F7nice span[aria-hidden="true"]', '.MW4etd', '.fontDisplayLarge');
    const rating    = ratingRaw ? parseFloat(ratingRaw) : null;

    // Review count — primary: .F7nice aria-label, secondary: any element with "reviews" label
    const revEl = document.querySelector('.F7nice') || document.querySelector('[aria-label*="review" i]');
    const revText = revEl?.getAttribute('aria-label') || revEl?.textContent || '';
    const revMatch = revText.match(/([\d,]+)\s*review/i);
    const totalReviews = revMatch ? parseInt(revMatch[1].replace(/,/g, ''), 10) : 0;

    // Address — primary: data-item-id, secondary: data-tooltip, tertiary: aria-label
    const address = tryText(
      'button[data-item-id="address"] .Io6YTe',
      '[data-tooltip="Copy address"] .Io6YTe',
      'button[data-item-id="address"] .rogA2c',
      '[aria-label*="Address" i]'
    );

    // Phone — primary: data-item-id phone, secondary: data-tooltip, tertiary: aria-label
    const phone = tryText(
      'button[data-item-id^="phone:tel"] .Io6YTe',
      '[data-tooltip="Copy phone number"] .Io6YTe',
      'button[data-item-id^="phone:tel"] .rogA2c',
      '[aria-label*="Phone" i][role="button"]'
    );

    // Website — primary: authority link, secondary: aria-label, tertiary: external link
    const website = tryAttr('href',
      'a[data-item-id="authority"]',
      'a[aria-label*="website" i]',
      'a[aria-label*="Website" i]',
      'a[data-tooltip*="website" i]'
    );

    // Category — primary: .DkEaL, secondary: button.DkEaL, tertiary: category label
    const category = tryText('.DkEaL', 'button.DkEaL', '.fontBodyMedium [jsaction*="category"]', '[data-attrid="subtitle"]');

    // Price level
    const priceLevel = tryText('[aria-label*="price range" i]', '[aria-label*="Price" i]');

    // Description — primary: .PYvSYb, secondary: data-attrid, tertiary: editorial summary
    const description = tryText('.PYvSYb', '[data-attrid="description"] span', '.WeS02d', '.editorial-summary span');

    // Opening hours — try multiple table selectors
    const hourRows = [...document.querySelectorAll('table.WgFkxc tr, .t39EBf tr, table.eK4R0e tr, [aria-label*="hours" i] table tr')];
    const openingHours = hourRows.map(row => {
      const cells = row.querySelectorAll('td, th');
      const day   = cells[0]?.textContent?.trim();
      const times = cells[1]?.textContent?.trim();
      if (!day) return null;
      const closed  = !times || /closed/i.test(times);
      const open24  = /open 24/i.test(times);
      const parts   = times?.split('–').map(s => s.trim()) || [];
      return { day, open: parts[0] || null, close: parts[1] || null, isClosed: closed, isOpen24: open24 };
    }).filter(Boolean);

    // Open now — try multiple selectors
    const openNowEl = document.querySelector('.dpoVLd, .o0Svhf, [aria-label*="Open now" i], [aria-label*="Closed" i]');
    const isOpenNow = openNowEl ? /open now/i.test(openNowEl.textContent) : null;

    // Plus code
    const plusCode = tryText('button[data-item-id="oloc"] .Io6YTe', 'button[data-item-id="oloc"] .rogA2c');

    // Amenities / highlights — try multiple selector patterns
    const amenityEls = tryAll(
      '[aria-label].iP2t7d', '.E0DTEd [aria-label]',
      '.LQjSr [aria-label]', '.CK16pd [aria-label]'
    );
    const amenities = amenityEls.map(el => el.getAttribute('aria-label')).filter(Boolean);

    const highlightEls = tryAll('.aSftqf .iP2t7d', '.PJEMsc li', '.m6QErb .iP2t7d');
    const highlights = highlightEls.map(el => el.getAttribute('aria-label') || el.textContent?.trim()).filter(Boolean);

    const serviceOptionEls = tryAll('.LTs0Rc li span', '.E0DTEd li span');
    const serviceOptions = serviceOptionEls.map(el => el.textContent?.trim()).filter(Boolean);

    // Lat/lng from URL
    const urlMatch = window.location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const lat = urlMatch ? parseFloat(urlMatch[1]) : null;
    const lng = urlMatch ? parseFloat(urlMatch[2]) : null;

    // Place ID from URL data-lsp attribute or URL path
    const pidMatch = window.location.href.match(/!1s(ChIJ[^!]+)/);
    const placeId  = pidMatch ? pidMatch[1] : null;

    // Photo URLs (visible on main page — hero images, no tab navigation needed)
    const photoSelectors = 'button[jsaction*="heroHeaderImage"] img, .RZ66Rb img, .Uf0tqf img, a[data-photo-index] img, [data-photo-index] img, .p6VvSf img, .ZKbJif img';
    const photoUrls = [...new Set(
      [...document.querySelectorAll(photoSelectors)]
        .map(img => img.src || img.dataset?.src)
        .filter(src => src?.startsWith('http') && src.includes('googleusercontent') && !src.includes('StreetView'))
        .map(src => src.replace(/=w\d+-h\d+[^&]*/, '=w1600-h1200'))
    )];

    // Rating breakdown — try multiple selectors
    const starEls = [...document.querySelectorAll('.jANrlb .dneCp, .JdqNPe .dneCp, .ExlQHd [role="img"]')];
    const starKeys = ['fiveStar','fourStar','threeStar','twoStar','oneStar'];
    const ratingBreakdown = Object.fromEntries(starKeys.map(k => [k, 0]));
    starEls.slice(0, 5).forEach((el, i) => {
      const lbl = el.closest('[aria-label]')?.getAttribute('aria-label') || '';
      const n   = parseInt(lbl.replace(/[^0-9]/g, '') || '0', 10);
      if (starKeys[i]) ratingBreakdown[starKeys[i]] = n;
    });

    // Popular Times (on main overview page)
    const popularTimes = [...document.querySelectorAll('[aria-label*="busy at" i], [aria-label*="Busy at" i], [aria-label*="Usually" i]')]
      .map(el => el.getAttribute('aria-label')).filter(Boolean);

    const permanentlyClosed = !!document.querySelector('.eXlrNe, [aria-label*="Permanently closed" i]');

    return {
      name, rating, totalReviews, address, phone, website,
      category, priceLevel, description, openingHours, isOpenNow,
      plusCode, amenities, highlights, serviceOptions, photoUrls,
      lat, lng, placeId, ratingBreakdown, permanentlyClosed, popularTimes,
      googleMapsUrl: window.location.href,
    };
  });

  if (!core.name) throw new Error('Could not extract space name — page may not have loaded correctly');

  // ── Fast mode: return immediately with hero data only ────────────────────
  if (mode === 'fast') {
    return { ...core, reviews: [], reviewSummary: null, photoUrls: core.photoUrls };
  }

  // ── About Tab (Deep Amenities) ──────────────────────────────────────────
  const deepAmenities = await scrapeAboutTab(page);

  // ── Reviews ──────────────────────────────────────────────────────────────
  const { reviews, reviewSummary } = await scrapeReviews(page, maxReviews);

  // ── All photos tab ────────────────────────────────────────────────────────
  const allPhotos = await scrapePhotosTab(page, core.photoUrls || [], maxPhotos);

  const mergedAmenities = [...new Set([...(core.amenities || []), ...(deepAmenities || [])])];

  // ── Website Photos (Supplementary) ───────────────────────────────────────
  // Only attempt if we have a browser context (ctx) — scrapeWebsitePhotos
  // needs its own page to avoid navigating this Google Maps page away.
  if (core.website && mode !== 'fast' && ctx) {
    try {
      const webPhotos = await scrapeWebsitePhotos(ctx, core.website);
      if (webPhotos?.length > 0) {
        allPhotos.push(...webPhotos);
      }
    } catch (e) {
      logger.warn(`Failed to scrape website photos for ${core.name}: ${e.message}`);
    }
  }

  return { ...core, amenities: mergedAmenities, reviews, reviewSummary, photoUrls: [...new Set(allPhotos)] };
}

// ── Enrichment Detail Scraper — Tasks 1–5 (URL capture only, no downloads) ────
// Navigates directly to a known space URL and extracts all enrichment data points.
// Called by processEnrichmentJob(). Returns enrichment-specific fields only.

async function scrapeEnrichmentDetail(page, url) {
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.scraper.timeout });
    } catch (_) {
      await page.goto(url, { waitUntil: 'commit', timeout: cfg.scraper.timeout });
    }
    await sleep(1800, 2800);
  } catch (err) {
    throw new Error(`Navigation failed: ${err.message}`);
  }

  const blockReason = await isBlocked(page);
  if (blockReason) {
    await sleep(15000, 30000);
    throw new Error(`Google blocked: ${blockReason}`);
  }

  // ── Task 3 + 5: Core data + operational + contact enrichment ─────────────
  const core = await page.evaluate(() => {
    const t  = s => document.querySelector(s)?.textContent?.trim() || null;
    const a  = (s, attr) => document.querySelector(s)?.getAttribute(attr) || null;

    // Task 5: Contact enrichment
    const phone  = t('button[data-item-id^="phone:tel"] .Io6YTe') || t('[data-tooltip="Copy phone number"] .Io6YTe');
    // Attempt secondary phone (some spaces list two)
    const allPhones = [...document.querySelectorAll('button[data-item-id^="phone:tel"] .Io6YTe')].map(el => el.textContent?.trim()).filter(Boolean);
    const phone2 = allPhones.length > 1 ? allPhones[1] : null;
    const website = a('a[data-item-id="authority"]', 'href') || a('a[aria-label*="website" i]', 'href');
    // Booking URL — "Book" / "Reserve" CTA buttons
    const bookingUrl = a('a[aria-label*="Book" i], a[aria-label*="Reserve" i], a[data-item-id*="booking" i]', 'href');
    // Menu URL — some spaces expose a schedule/menu link
    const menuUrl = a('a[aria-label*="menu" i], a[aria-label*="class schedule" i]', 'href');
    // Social links — look for icon-decorated links in the info panel
    const allLinks = [...document.querySelectorAll('a[href]')].map(el => el.href).filter(Boolean);
    const instagram  = allLinks.find(h => h.includes('instagram.com')) || null;
    const facebook   = allLinks.find(h => h.includes('facebook.com')) || null;
    const youtube    = allLinks.find(h => h.includes('youtube.com')) || null;
    const whatsapp   = allLinks.find(h => h.includes('wa.me') || h.includes('whatsapp.com')) || null;

    // Task 3: Opening hours
    const hourRows = [...document.querySelectorAll('table.WgFkxc tr, .t39EBf tr')];
    const openingHours = hourRows.map(row => {
      const cells = row.querySelectorAll('td, th');
      const day   = cells[0]?.textContent?.trim();
      const times = cells[1]?.textContent?.trim();
      if (!day) return null;
      const closed = !times || /closed/i.test(times);
      const open24 = /open 24/i.test(times);
      const parts  = times?.split('\u2013').map(s => s.trim()) || [];
      return { day, open: parts[0] || null, close: parts[1] || null, isClosed: closed, isOpen24: open24 };
    }).filter(Boolean);

    // Task 3: Special hours (holiday overrides) — these appear in a dedicated section
    const specialHoursEls = [...document.querySelectorAll('.ZDu9vd, [data-attrid*="special_hours" i] tr')];
    const specialHours = specialHoursEls.map(row => {
      const cells = row.querySelectorAll('td, th');
      const label = cells[0]?.textContent?.trim();
      const times  = cells[1]?.textContent?.trim();
      if (!label) return null;
      return { date: null, label, open: times?.split('\u2013')[0]?.trim() || null, close: times?.split('\u2013')[1]?.trim() || null, isClosed: !times || /closed/i.test(times) };
    }).filter(Boolean);

    // Task 3: isOpenNow
    const openNowEl = document.querySelector('.dpoVLd, [aria-label*="Open now" i], [aria-label*="Closed" i]');
    const isOpenNow = openNowEl ? /open now/i.test(openNowEl.textContent) : null;

    // Task 3: Popular times — structured busyness data
    // Google renders popular times as aria-label="X% busy at Yam/pm" on bar segments
    const ptMap = {};
    const ptEls = [...document.querySelectorAll('[aria-label*="% busy at" i], [aria-label*="Busyness" i], [class*="popular-times"] [aria-label]')];
    ptEls.forEach(el => {
      const lbl = el.getAttribute('aria-label') || '';
      // Pattern: "Usually X% busy at Y [Day]"
      const match = lbl.match(/(\d+)%.*?(?:at|@)\s*(\d+)\s*(am|pm)?.*?([A-Za-z]+day)?/i);
      if (!match) return;
      const pct  = parseInt(match[1], 10);
      let   hour = parseInt(match[2], 10);
      const ampm = (match[3] || '').toLowerCase();
      // Get the day from nearest day heading
      const day = el.closest('[data-day]')?.getAttribute('data-day') || match[4] || null;
      if (!day) return;
      if (ampm === 'pm' && hour !== 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      if (!ptMap[day]) ptMap[day] = [];
      ptMap[day].push({ hour, busyness: pct });
    });
    const popularTimesData = Object.entries(ptMap).map(([day, hours]) => ({ day, hours: hours.sort((a, b) => a.hour - b.hour) }));

    // Task 4: Pricing text
    const priceLevel = t('[aria-label*="price range" i]') || null;
    const pricingRawText = document.querySelector('.mgr77e, .YhemCb, [data-attrid*="price" i]')?.textContent?.trim() || priceLevel || null;

    // Task 1: Cover photo from hero
    const heroImg = document.querySelector('button[jsaction*="heroHeaderImage"] img, .RZ66Rb img:first-child');
    const coverPhotoUrl = heroImg ? (heroImg.src || heroImg.dataset?.src) : null;

    // Task 1: All hero/overview photo URLs (high-res)
    const heroPhotoUrls = [...new Set(
      [...document.querySelectorAll('button[jsaction*="heroHeaderImage"] img, .RZ66Rb img, .Uf0tqf img, a[data-photo-index] img, [data-photo-index] img')]
        .map(img => img.src || img.dataset?.src)
        .filter(src => src?.startsWith('http') && src.includes('googleusercontent') && !src.includes('StreetView'))
        .map(src => src.replace(/=w\d+-h\d+[^&]*/, '=w1600-h1200'))
    )];

    // Task 1: Video thumbnails (data-thumbnail-url or video elements)
    const videoThumbUrls = [...document.querySelectorAll('[data-thumbnail-url], video[poster]')]
      .map(el => el.getAttribute('data-thumbnail-url') || el.getAttribute('poster'))
      .filter(Boolean);

    return {
      phone, phone2, website, bookingUrl, menuUrl,
      instagram, facebook, youtube, whatsapp,
      openingHours, specialHours, isOpenNow, popularTimesData,
      priceLevel, pricingRawText,
      coverPhotoUrl, heroPhotoUrls, videoThumbUrls,
      googleMapsUrl: window.location.href,
    };
  });

  // ── Task 4: Exhaustive About Tab ─────────────────────────────────────────
  const { amenities: deepAmenities, extraAttributes } = await scrapeAboutTabExhaustive(page);

  // ── Task 2: Deep review scrape ────────────────────────────────────────────
  const { reviews, reviewSummary } = await scrapeReviews(page, cfg.scraper.enrichMaxReviews);

  // ── Task 1: Full photo tab (URL capture, no downloads) ───────────────────
  const allPhotoUrls = await scrapePhotosTabEnriched(page, core.heroPhotoUrls || []);

  return {
    ...core,
    deepAmenities,
    extraAttributes,
    reviews,
    reviewSummary,
    allPhotoUrls,
    scrapedAt: new Date(),
  };
}

// ── Scrape About Tab (Detailed Amenities & Accessibility) ──────────────────
async function scrapeAboutTab(page) {
  try {
    const tab = page.locator('button[aria-label*="About" i], button:has-text("About")').first();
    if (!await tab.isVisible({ timeout: 1500 }).catch(() => false)) return null;
    await tab.click({ force: true });
    await sleep(800, 1400);

    return await page.evaluate(() => {
      const items = [...document.querySelectorAll('.hpLkke, .E0DTEd li, .kx8XBd, .iP2t7d')];
      return items.map(el => el.textContent?.trim() || el.getAttribute('aria-label')).filter(Boolean);
    });
  } catch (err) {
    return null;
  }
}

// ── Task 4: Exhaustive About Tab — all sections incl. unmapped ─────────────
async function scrapeAboutTabExhaustive(page) {
  const result = { amenities: [], extraAttributes: {} };
  try {
    const tab = page.locator('button[aria-label*="About" i], button:has-text("About")').first();
    if (!await tab.isVisible({ timeout: 1500 }).catch(() => false)) return result;
    await tab.click({ force: true });
    await sleep(800, 1400);

    return await page.evaluate(() => {
      const KNOWN_SECTIONS = new Set([
        'amenities', 'offerings', 'accessibility', 'service options', 'highlights',
        'planning', 'payments', 'children', 'crowd', 'health & safety',
      ]);
      const result = { amenities: [], extraAttributes: {} };

      // Each section is a heading + list of items
      const sections = [...document.querySelectorAll('.iP2t7d, .E0DTEd, .OEuBte, .section-result-category')];
      let currentSection = null;

      // Walk the DOM tree for section headers + their items
      const allEls = [...document.querySelectorAll('.LTs0Rc, .hpLkke, .E0DTEd li, .kx8XBd, .iP2t7d, .RCZH2e')];
      for (const el of allEls) {
        // Section heading detection
        if (el.tagName === 'H2' || el.tagName === 'H3' || el.classList.contains('LTs0Rc')) {
          currentSection = el.textContent?.trim().toLowerCase() || null;
          continue;
        }
        const text = el.textContent?.trim() || el.getAttribute('aria-label');
        if (!text) continue;

        if (!currentSection || KNOWN_SECTIONS.has(currentSection)) {
          result.amenities.push(text);
        } else {
          // Store in extraAttributes for unmapped sections
          if (!result.extraAttributes[currentSection]) result.extraAttributes[currentSection] = [];
          result.extraAttributes[currentSection].push(text);
        }
      }

      // De-dupe
      result.amenities = [...new Set(result.amenities)];
      return result;
    });
  } catch (err) {
    return result;
  }
}

// ── Task 2: Enhanced review scraper (enrichment fields) ─────────────────────
async function scrapeReviews(page, maxReviews = 30) {
  const reviews = [];
  let reviewSummary = null;

  if (maxReviews === 0) return { reviews, reviewSummary };

  try {
    let tab = page.locator('[role="tab"][aria-label*="Reviews" i], [role="tab"]:has-text("Reviews")').first();
    if (!await tab.isVisible({ timeout: 1500 }).catch(() => false)) {
      tab = page.locator('button[aria-label*="reviews" i], button:has-text("Reviews")').first();
    }
    if (!await tab.isVisible({ timeout: 1500 }).catch(() => false)) return { reviews, reviewSummary };
    await tab.click({ force: true });
    await sleep(1200, 2000);

    try {
      reviewSummary = await page.evaluate(() => {
        const aiSummary = document.querySelector('.P_Pval, .OA1nbd, .d7Bzhf')?.textContent?.trim();
        const keywords = [...document.querySelectorAll('.fontBodySmall.Cw1rxd')].map(el => el.textContent?.trim()).join(', ');
        return aiSummary || keywords || null;
      });
    } catch (_) {}

    try {
      const sortBtn = page.locator('button[aria-label*="Sort" i]').first();
      if (await sortBtn.isVisible({ timeout: 1500 })) {
        await sortBtn.click({ force: true });
        await sleep(400, 700);
        await page.locator('li[data-index="1"], li:has-text("Newest")').first().click({ timeout: 1500, force: true });
        await sleep(800, 1400);
      }
    } catch (_) {}

    const panel = page.locator('.m6QErb[aria-label*="review" i], .DxyBCb').first();
    let lastCount = 0; let noNew = 0;

    while (reviews.length < maxReviews) {
      for (const btn of await page.locator('button.w8nwRe, button:has-text("More")').all()) {
        try { await btn.click({ force: true }); } catch (_) {}
      }
      await sleep(300, 500); // Wait for text expansion

      for (const card of await page.locator('.jftiEf, .MyEned').all()) {
        try {
          const r = await card.evaluate(el => {
            const t  = s => el.querySelector(s)?.textContent?.trim() || null;
            const g  = (s, a) => el.querySelector(s)?.getAttribute(a) || null;
            const ratingLabel = g('.kvMYJc', 'aria-label') || '';
            const ratingNum   = parseInt(ratingLabel.replace(/[^0-9]/g, '') || '0', 10) || null;

            // Task 2: Local Guide level
            const lgText = t('.RfnDt, .QMUNef');
            const lgMatch = lgText?.match(/Local Guide.*Level (\d+)/i);
            const reviewerLocalGuideLevel = lgMatch ? parseInt(lgMatch[1], 10) : null;

            // Task 2: Review photos (URLs only, no download)
            const reviewPhotos = [...el.querySelectorAll('.KtCyie img, .Tya61d img')]
              .map(img => img.src || img.dataset?.src)
              .filter(src => src?.startsWith('http'))
              .map(src => src.replace(/=w\d+-h\d+[^&]*/, '=w800-h600'));

            // Task 2: Owner reply with respondedAt
            let ownerReplyText = null;
            let ownerRespondedAtRaw = null;
            const ownerReplyBlock = el.querySelector('.CDe7pd');
            if (ownerReplyBlock) {
              ownerReplyText = ownerReplyBlock.querySelector('.wiI7pd')?.textContent?.trim() || ownerReplyBlock.textContent?.trim();
              if (ownerReplyText) {
                ownerReplyText = ownerReplyText.replace(/^Response from the owner.*?ago\s*/i, '').trim();
                ownerReplyText = ownerReplyText.replace(/^["'“”‘’`´«»\s]+|["'“”‘’`´«»\s]+$/g, '');
                ownerReplyText = ownerReplyText.replace(/(?:\.\.\.\s*)?More$/i, '').trim(); // Remove trailing "More" if unexpanded
              }
              ownerRespondedAtRaw = ownerReplyBlock.querySelector('.n5VP6b')?.textContent?.trim() || t('.n5VP6b');
            }

            let text = t('.wiI7pd') || t('.MyEned span');
            if (text) {
              text = text.replace(/^["'“”‘’`´«»\s]+|["'“”‘’`´«»\s]+$/g, '');
              text = text.replace(/(?:\.\.\.\s*)?More$/i, '').trim(); // Remove trailing "More" if unexpanded
            }

            return {
              reviewId:    el.getAttribute('data-review-id') || null,
              authorName:  t('.d4r55') || t('.GHT2ce'),
              authorUrl:   g('.al6Kxe', 'href'),
              authorAvatar:g('.NBa7we img', 'src'),
              reviewerLocalGuideLevel,
              rating:      ratingNum,
              text:        text,
              publishedAt: t('.rsqaWe') || t('.xRkPPb span'),
              likes:       parseInt(t('.GBkF3d') || '0', 10) || 0,
              reviewPhotos,
              ownerReply:  ownerReplyText
                ? { text: ownerReplyText, respondedAt: ownerRespondedAtRaw }
                : null,
            };
          });
          if (r.authorName && !reviews.some(x => x.reviewId && x.reviewId === r.reviewId)) {
            reviews.push(r);
          }
        } catch (_) {}
      }

      if (reviews.length === lastCount) { if (++noNew >= 3) break; }
      else noNew = 0;
      lastCount = reviews.length;

      try { await panel.evaluate(el => el.scrollBy(0, 1800)); }
      catch (_) { await page.mouse.wheel(0, 1800); }
      await sleep(1000, 1800);
    }
  } catch (err) {
    logger.warn(`Review scraping partial: ${err.message}`);
  }
  return { reviews, reviewSummary };
}

// ── Task 1: Enriched photo tab — captures up to maxPhotos, no size cap ────────
async function scrapePhotosTabEnriched(page, existing = []) {
  const maxPhotos = cfg.scraper.enrichMaxPhotos;
  return scrapePhotosTab(page, existing, maxPhotos);
}

// ── Scrape Photos tab (up to maxPhotos) ───────────────────────────────────────
// Phase 4: maxPhotos is now a parameter (20 for standard, 80 for deep, 0 for fast)

async function scrapePhotosTab(page, existing = [], maxPhotos = 20) {
  const urls = new Set(existing);

  if (maxPhotos === 0) return [...urls];

  try {
    let tab = page.locator('[role="tab"][aria-label*="Photos" i], [role="tab"]:has-text("Photos")').first();
    if (!await tab.isVisible({ timeout: 1500 }).catch(() => false)) {
      tab = page.locator('button[aria-label*="Photos" i], button:has-text("Photos")').first();
    }
    if (!await tab.isVisible({ timeout: 1500 }).catch(() => false)) return [...urls];
    await tab.click({ force: true });
    await sleep(1200, 2000);

    let last = 0; let noNew = 0;
    while (urls.size < maxPhotos) {
      const imgs = await page.locator('.Uf0tqf img, .RZ66Rb img, .U39Pmb img, a[data-photo-index] img, [data-photo-index] img, img').all();
      for (const img of imgs) {
        try {
          const src = await img.getAttribute('src') || await img.getAttribute('data-src');
          if (src?.startsWith('http') && src.includes('googleusercontent') && !src.includes('StreetView')) {
             urls.add(src.replace(/=w\d+-h\d+[^&]*/, '=w1600-h1200'));
          }
        } catch (_) {}
      }
      if (urls.size === last) { if (++noNew >= 3) break; }
      else noNew = 0;
      last = urls.size;
      await page.mouse.wheel(0, 1500);
      await sleep(800, 1500);
    }
  } catch (err) {
    logger.warn(`Photo tab scraping partial: ${err.message}`);
  }
  return [...urls];
}

// ── Selective Scraper — scrape only requested sections ────────────────────────
// sections: array of ['reviews', 'photos', 'contact', 'hours', 'amenities', 'deep', 'all']

async function scrapeSelective(page, url, sections = ['all']) {
  const isAll = sections.includes('all');
  const isDeep = sections.includes('deep');

  // If 'all' or 'deep', delegate to existing scrapeSpaceDetail
  if (isAll) return scrapeSpaceDetail(page, url, 'standard');
  if (isDeep) return scrapeSpaceDetail(page, url, 'deep');

  // Navigate to the page and get core data (always needed for context)
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.scraper.timeout });
    } catch (_) {
      await page.goto(url, { waitUntil: 'commit', timeout: cfg.scraper.timeout });
    }
    await sleep(1800, 2800);
  } catch (err) {
    throw new Error(`Navigation failed: ${err.message}`);
  }

  const blockReason = await isBlocked(page);
  if (blockReason) {
    await sleep(15000, 30000);
    throw new Error(`Google blocked: ${blockReason}`);
  }

  // Always scrape core data (fast — no tab navigation)
  const core = await page.evaluate(() => {
    const t  = s => document.querySelector(s)?.textContent?.trim() || null;
    const a  = (s, attr) => document.querySelector(s)?.getAttribute(attr) || null;
    const name = t('h1.DUwDvf') || t('h1');
    const ratingRaw = t('.F7nice span[aria-hidden="true"]') || t('.MW4etd');
    const rating = ratingRaw ? parseFloat(ratingRaw) : null;
    const revText = document.querySelector('.F7nice')?.getAttribute('aria-label') || '';
    const revMatch = revText.match(/([\d,]+)\s*review/i);
    const totalReviews = revMatch ? parseInt(revMatch[1].replace(/,/g, ''), 10) : 0;
    const address = t('button[data-item-id="address"] .Io6YTe') || t('[data-tooltip="Copy address"] .Io6YTe');
    const phone = t('button[data-item-id^="phone:tel"] .Io6YTe') || t('[data-tooltip="Copy phone number"] .Io6YTe');
    const website = a('a[data-item-id="authority"]', 'href') || a('a[aria-label*="website" i]', 'href');
    const category = t('.DkEaL') || t('button.DkEaL') || null;
    const description = t('.PYvSYb') || null;
    const hourRows = [...document.querySelectorAll('table.WgFkxc tr, .t39EBf tr')];
    const openingHours = hourRows.map(row => {
      const cells = row.querySelectorAll('td, th');
      const day = cells[0]?.textContent?.trim();
      const times = cells[1]?.textContent?.trim();
      if (!day) return null;
      return { day, open: (times?.split('–')[0] || '').trim() || null, close: (times?.split('–')[1] || '').trim() || null, isClosed: !times || /closed/i.test(times), isOpen24: /open 24/i.test(times) };
    }).filter(Boolean);
    const isOpenNow = (() => { const el = document.querySelector('.dpoVLd, [aria-label*="Open now" i]'); return el ? /open now/i.test(el.textContent) : null; })();
    const amenities = [...document.querySelectorAll('[aria-label].iP2t7d, .E0DTEd [aria-label]')].map(el => el.getAttribute('aria-label')).filter(Boolean);
    const photoUrls = [...new Set([...document.querySelectorAll('button[jsaction*="heroHeaderImage"] img, .RZ66Rb img, .Uf0tqf img, a[data-photo-index] img, [data-photo-index] img')].map(img => img.src || img.dataset?.src).filter(src => src?.startsWith('http') && src.includes('googleusercontent') && !src.includes('StreetView')).map(src => src.replace(/=w\d+-h\d+[^&]*/, '=w1600-h1200')))];
    const urlMatch = window.location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    return {
      name, rating, totalReviews, address, phone, website, category, description,
      openingHours, isOpenNow, amenities, photoUrls,
      lat: urlMatch ? parseFloat(urlMatch[1]) : null,
      lng: urlMatch ? parseFloat(urlMatch[2]) : null,
      googleMapsUrl: window.location.href,
    };
  });

  if (!core.name) throw new Error('Could not extract space name — page may not have loaded correctly');

  // Build result — start with core, selectively add sections
  const result = { ...core, reviews: [], reviewSummary: null };

  const wantReviews   = sections.includes('reviews');
  const wantPhotos    = sections.includes('photos');
  const wantAmenities = sections.includes('amenities');
  // contact + hours are already in core data — no extra work needed

  if (wantAmenities) {
    const deep = await scrapeAboutTab(page);
    if (deep) result.amenities = [...new Set([...(core.amenities || []), ...deep])];
  }

  if (wantReviews) {
    const { reviews, reviewSummary } = await scrapeReviews(page, cfg.scraper.maxReviews);
    result.reviews = reviews;
    result.reviewSummary = reviewSummary;
  }

  if (wantPhotos) {
    result.photoUrls = await scrapePhotosTab(page, core.photoUrls || [], cfg.scraper.maxPhotos);
  }

  // Track which sections were scraped (for logging)
  result._scrapedSections = sections;

  return result;
}

module.exports = {
  BrowserManager, searchSpacesInCity, searchSpacesInGrid, scrapeSpaceDetail, scrapeEnrichmentDetail, scrapeSelective,
  scrapeAboutTab, scrapeAboutTabExhaustive, scrapeReviews, scrapePhotosTab, scrapePhotosTabEnriched,
  FITNESS_CATEGORIES, isBlocked,
};

