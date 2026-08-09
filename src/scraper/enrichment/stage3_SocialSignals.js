'use strict';
/**
 * Stage 3 — Social Signals
 * Collects signals from:
 * - Google Search (mentions, news articles) via SerpAPI/Serper.dev
 * - Instagram (location tag page — public posts count, popular tags)
 * - Facebook (public business page info via Graph API)
 */

const axios = require('axios');
const cfg   = require('../../../config');
const logger = require('../../utils/logger');

async function runStage3(space) {
  const updates = {};
  const signals = {};

  await Promise.allSettled([
    _fetchGoogleMentions(space, signals),
    _fetchInstagramSignals(space, signals),
    _fetchFacebookSignals(space, signals),
  ]);

  if (signals.instagramHandle)  updates['contact.instagram'] = signals.instagramHandle;
  if (signals.facebookUrl)      updates['contact.facebook']  = signals.facebookUrl;
  if (signals.verifiedWebsite && !space.contact?.website)
    updates['contact.website'] = signals.verifiedWebsite;

  // Merge additional photo URLs found from social
  if (signals.extraPhotoUrls?.length) updates._newPhotoUrls = signals.extraPhotoUrls;

  updates._stageData = signals;
  return updates;
}

async function _fetchGoogleMentions(space, signals) {
  const key    = cfg.sources?.serpApiKey || cfg.sources?.serperKey;
  const isSerp = !!cfg.sources?.serpApiKey;
  if (!key) return;

  const query = `"${space.name}" ${space.city || ''} gym fitness`;
  try {
    let results = [];
    if (isSerp) {
      const resp = await axios.get('https://serpapi.com/search.json', {
        params: { q: query, engine: 'google', num: 10, api_key: key },
        timeout: 10000,
      });
      results = resp.data?.organic_results || [];
    } else {
      const resp = await axios.post('https://google.serper.dev/search',
        { q: query, num: 10 },
        { headers: { 'X-API-KEY': key }, timeout: 10000 }
      );
      results = resp.data?.organic || [];
    }

    // Extract Instagram/Facebook handles from search results
    for (const r of results) {
      const url = r.link || r.url || '';
      if (/instagram\.com\/[^/?]+/.test(url) && !signals.instagramHandle) {
        const match = url.match(/instagram\.com\/([^/?]+)/);
        if (match) signals.instagramHandle = `https://www.instagram.com/${match[1]}/`;
      }
      if (/facebook\.com\/[^/?]+/.test(url) && !signals.facebookUrl) {
        const match = url.match(/facebook\.com\/([^/?]+)/);
        if (match) signals.facebookUrl = `https://www.facebook.com/${match[1]}/`;
      }
    }
  } catch (err) {
    logger.debug(`[stage3] Google mentions failed: ${err.message}`);
  }
}

async function _fetchInstagramSignals(space, signals) {
  // Instagram public location page (no API key needed for basic info)
  if (!space.placeId) return;
  // Skip — Instagram location scraping is rate-limited and fragile.
  // Reserved for future implementation with session cookies or official API.
}

async function _fetchFacebookSignals(space, signals) {
  const token = cfg.sources?.fbAccessToken;
  if (!token || !space.name) return;

  try {
    const resp = await axios.get('https://graph.facebook.com/v19.0/search', {
      params: {
        q: space.name,
        type: 'place',
        fields: 'name,location,link,phone,website,cover',
        center: space.location?.coordinates ? `${space.location.coordinates[1]},${space.location.coordinates[0]}` : undefined,
        distance: 500,
        access_token: token,
      },
      timeout: 10000,
    });

    const places = resp.data?.data || [];
    const match  = places.find(p => {
      const n = (p.name || '').toLowerCase();
      const q = (space.name || '').toLowerCase();
      return n.includes(q.split(' ')[0]) || q.includes(n.split(' ')[0]);
    });

    if (match) {
      if (match.link)    signals.facebookUrl      = match.link;
      if (match.website) signals.verifiedWebsite  = match.website;
      if (match.cover?.source) signals.extraPhotoUrls = [match.cover.source];
    }
  } catch (err) {
    logger.debug(`[stage3] Facebook search failed: ${err.message}`);
  }
}

module.exports = { runStage3 };
