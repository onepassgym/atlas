'use strict';

const logger = require('../utils/logger');

/**
 * Extracts high-quality photo URLs from a space's official website.
 * Looks for OpenGraph images, Twitter cards, and large <img> tags.
 */
async function scrapeWebsitePhotos(page, websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http')) return [];
  
  try {
    // Navigate with a fast timeout and only wait for DOM to be ready
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Slight pause to let lazy-loaded scripts inject images if they do it instantly
    await page.waitForTimeout(1000).catch(() => {});
    
    const photoUrls = await page.evaluate(() => {
      const urls = new Set();
      
      // Helper to resolve relative URLs
      const resolveUrl = (src) => {
        try { return new URL(src, window.location.href).href; }
        catch { return null; }
      };
      
      // 1. Meta tags (high quality hero images usually)
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage && ogImage.content) {
        const url = resolveUrl(ogImage.content);
        if (url) urls.add(url);
      }
      
      const twImage = document.querySelector('meta[name="twitter:image"]');
      if (twImage && twImage.content) {
        const url = resolveUrl(twImage.content);
        if (url) urls.add(url);
      }
      
      // 2. background-image from large divs (often hero sections)
      const divs = document.querySelectorAll('div, section, header');
      for (const el of divs) {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none' && bg.includes('url(')) {
          const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
          if (match && match[1]) {
            const url = resolveUrl(match[1]);
            // Skip data URIs
            if (url && url.startsWith('http')) urls.add(url);
          }
        }
      }

      // 3. Img tags (filter for reasonable size to avoid icons/logos)
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.src || img.dataset?.src || img.getAttribute('data-lazy-src') || img.getAttribute('data-src');
        if (!src) continue;
        
        const url = resolveUrl(src);
        if (!url || !url.startsWith('http')) continue;
        
        // Skip obvious icons/logos/trackers
        const lowerSrc = url.toLowerCase();
        if (lowerSrc.includes('logo') || lowerSrc.includes('icon') || lowerSrc.includes('avatar') || lowerSrc.includes('pixel') || lowerSrc.endsWith('.svg')) continue;
        
        // We only want relatively large images, but computed size might be 0 if lazy loaded
        // So we just take them and let the downloader's `photoVision.js` weed out bad ones
        urls.add(url);
      }
      
      return Array.from(urls).slice(0, 15); // Cap to 15 to avoid overloading
    });

    logger.info(`  🌐 Extracted ${photoUrls.length} supplementary photos from ${websiteUrl}`);
    return photoUrls;

  } catch (err) {
    logger.warn(`  🌐 Failed to scrape website photos from ${websiteUrl}: ${err.message}`);
    return []; 
  }
}

module.exports = { scrapeWebsitePhotos };
