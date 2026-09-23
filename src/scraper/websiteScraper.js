'use strict';

const logger = require('../utils/logger');

const WEBSITE_TIMEOUT_MS = parseInt(process.env.WEBSITE_SCRAPE_TIMEOUT_MS || '20000', 10);

// Hosts that are social profiles, link-in-bio pages or messaging links, not a
// venue's own site. Browsing them hits login walls; we file them as contact
// links instead (see classifySocialUrl).
const SOCIAL_HOSTS = [
  ['instagram', /(^|\.)instagram\.com$/i],
  ['facebook',  /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i],
  ['youtube',   /(^|\.)(youtube\.com|youtu\.be)$/i],
  ['whatsapp',  /(^|\.)(wa\.me|whatsapp\.com)$/i],
  ['twitter',   /(^|\.)(twitter\.com|x\.com)$/i],
  ['linkedin',  /(^|\.)linkedin\.com$/i],
];
const NON_SITE_HOSTS = /(^|\.)(linktr\.ee|bit\.ly|goo\.gl|g\.page|maps\.google\.com|google\.com|business\.site)$/i;

/**
 * True only for a link to a specific profile/page, not a network's homepage.
 * Site templates routinely ship placeholder icons linking to
 * `https://instagram.com/` — those must never be saved as the venue's profile.
 */
function isSocialProfileUrl(url) {
  try {
    const u = new URL(url);
    const key = classifySocialUrl(url);
    if (!key) return false;
    const path = u.pathname.replace(/\/+$/, '');
    if (key === 'whatsapp') return /\d{8,}/.test(path + u.search);        // wa.me/<number> or ?phone=
    if (!path || path === '/') return key === 'facebook' && /[?&]id=\d+/.test(u.search); // profile.php?id=
    return !/^\/(sharer|share|intent|plugins|dialog|home|login|explore|watch|results|policies|help|privacy|legal|terms)(\/|\.php|$)/i.test(path);
  } catch (_) {
    return false;
  }
}

/** @returns {string|null} social network key if `url` is a social profile */
function classifySocialUrl(url) {
  try {
    const host = new URL(url).hostname;
    for (const [key, rx] of SOCIAL_HOSTS) if (rx.test(host)) return key;
  } catch (_) {}
  return null;
}

function isBrowsableSite(url) {
  try {
    const host = new URL(url).hostname;
    return !classifySocialUrl(url) && !NON_SITE_HOSTS.test(host);
  } catch (_) {
    return false;
  }
}

/**
 * Visit a venue's official website once and extract everything useful.
 *
 * Opens its OWN page via the browser context and closes it when done, so it
 * can never navigate a caller's Google Maps page away mid-scrape.
 *
 * @param {BrowserContext} ctx
 * @param {string} websiteUrl
 * @returns {Promise<{
 *   finalUrl: string, title: string|null, description: string|null,
 *   emails: string[], phones: string[], socials: Object<string,string>,
 *   photos: string[], bookingUrl: string|null,
 *   jsonLd: { openingHours: string[], priceRange: string|null, telephone: string|null, email: string|null, sameAs: string[] }
 * }>}
 */
async function scrapeWebsiteDetails(ctx, websiteUrl) {
  if (!websiteUrl || !/^https?:\/\//i.test(websiteUrl)) throw new Error('No valid website URL');

  let page = null;
  try {
    page = await ctx.newPage();
    const resp = await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: WEBSITE_TIMEOUT_MS });
    const status = resp?.status?.() || 0;
    if (status >= 400) throw new Error(`Website returned HTTP ${status}`);

    // Give client-rendered sites a moment; resolve early once the network calms.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
      const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || null;
      const html = document.documentElement.innerHTML;
      const text = document.body?.innerText || '';

      // ── Links ──────────────────────────────────────────────────────────
      const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '');
      const mailtos = links.filter(h => /^mailto:/i.test(h)).map(h => decodeURIComponent(h.slice(7).split('?')[0]));
      const tels = links.filter(h => /^tel:/i.test(h)).map(h => decodeURIComponent(h.slice(4)));
      const absLinks = links.map(abs).filter(Boolean);
      const bookingUrl = absLinks.find(h => /book|schedule|reserve|appointment|class(es)?-?timetable|membership|join/i.test(h) && !/facebook|instagram/i.test(h)) || null;

      // ── Emails in visible text / markup (obfuscation-light) ─────────────
      const emailRx = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
      const textEmails = (text.match(emailRx) || []).concat(html.match(emailRx) || []);

      // ── JSON-LD (schema.org LocalBusiness / ExerciseGym / SportsActivityLocation) ─
      const jsonLd = { openingHours: [], priceRange: null, telephone: null, email: null, sameAs: [] };
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node['@graph']) visit(node['@graph']);
        const oh = node.openingHours || node.openingHoursSpecification;
        if (typeof oh === 'string') jsonLd.openingHours.push(oh);
        else if (Array.isArray(oh)) oh.forEach(h => {
          if (typeof h === 'string') jsonLd.openingHours.push(h);
          else if (h?.dayOfWeek) {
            const days = [].concat(h.dayOfWeek).map(d => String(d).split('/').pop()).join(',');
            jsonLd.openingHours.push(`${days} ${h.opens || ''}-${h.closes || ''}`.trim());
          }
        });
        if (node.priceRange && !jsonLd.priceRange) jsonLd.priceRange = String(node.priceRange);
        if (node.telephone && !jsonLd.telephone) jsonLd.telephone = String(node.telephone);
        if (node.email && !jsonLd.email) jsonLd.email = String(node.email).replace(/^mailto:/i, '');
        if (node.sameAs) jsonLd.sameAs.push(...[].concat(node.sameAs).map(String));
      };
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { visit(JSON.parse(s.textContent)); } catch (_) {}
      }

      // ── Photos ─────────────────────────────────────────────────────────
      const photos = new Set();
      for (const sel of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
        const u = meta(sel); if (u) { const a = abs(u); if (a) photos.add(a); }
      }
      for (const el of document.querySelectorAll('section, header, div[class*="hero" i], div[class*="banner" i]')) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg !== 'none' ? bg.match(/url\(['"]?(.*?)['"]?\)/) : null;
        if (m?.[1]) { const a = abs(m[1]); if (a?.startsWith('http')) photos.add(a); }
      }
      for (const img of document.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        const a = src ? abs(src) : null;
        if (!a || !a.startsWith('http')) continue;
        if (/logo|icon|avatar|sprite|pixel|badge|flag|payment|\.svg(\?|$)/i.test(a)) continue;
        // naturalWidth is 0 for lazy/unloaded images — keep those, drop known-tiny ones
        if (img.naturalWidth && img.naturalWidth < 300) continue;
        photos.add(a);
      }

      return {
        finalUrl: location.href,
        title: document.title?.trim() || null,
        description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
        mailtos, tels, textEmails, absLinks, bookingUrl, jsonLd,
        photos: [...photos].slice(0, 25),
      };
    });

    // ── Clean up in Node (keeps the page.evaluate small and testable) ───────
    const junkEmail = /(example\.|sentry|wixpress|domain\.com|email\.com|yourdomain|\.(png|jpe?g|gif|webp|svg)$|^[0-9a-f]{16,}@)/i;
    const emails = [...new Set([...data.mailtos, ...(data.jsonLd.email ? [data.jsonLd.email] : []), ...data.textEmails]
      .map(e => e.trim().toLowerCase())
      .filter(e => /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(e) && !junkEmail.test(e)))].slice(0, 5);

    const phones = [...new Set([...data.tels, ...(data.jsonLd.telephone ? [data.jsonLd.telephone] : [])]
      .map(p => p.replace(/[^\d+]/g, ''))
      .filter(p => p.replace(/\D/g, '').length >= 8))].slice(0, 3);

    const socials = {};
    for (const href of [...data.absLinks, ...data.jsonLd.sameAs]) {
      const key = classifySocialUrl(href);
      if (key && !socials[key] && isSocialProfileUrl(href)) socials[key] = key === 'whatsapp' ? href : href.split('?')[0];
    }

    return {
      finalUrl: data.finalUrl,
      title: data.title,
      description: data.description,
      emails, phones, socials,
      photos: data.photos,
      bookingUrl: data.bookingUrl,
      jsonLd: { ...data.jsonLd, sameAs: [...new Set(data.jsonLd.sameAs)] },
    };
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

/**
 * Back-compat wrapper: photo URLs only, never throws.
 * @param {BrowserContext} ctx
 * @param {string} websiteUrl
 * @returns {Promise<string[]>}
 */
async function scrapeWebsitePhotos(ctx, websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http') || !isBrowsableSite(websiteUrl)) return [];
  try {
    const { photos } = await scrapeWebsiteDetails(ctx, websiteUrl);
    logger.info(`  🌐 Extracted ${photos.length} supplementary photos from ${websiteUrl}`);
    return photos.slice(0, 15);
  } catch (err) {
    logger.warn(`  🌐 Failed to scrape website photos from ${websiteUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { scrapeWebsiteDetails, scrapeWebsitePhotos, classifySocialUrl, isBrowsableSite, isSocialProfileUrl };
