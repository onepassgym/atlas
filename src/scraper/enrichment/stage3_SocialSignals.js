'use strict';
/**
 * Stage 3 — Social Signals
 * Collects signals from:
 * - DuckDuckGo (free, no API key) → official website domain + social handles
 * - Facebook Graph API (if token configured)
 */

const cfg    = require('../../../config');
const logger = require('../../utils/logger');

async function runStage3(space) {
  const updates = {};
  const signals = {};

  await Promise.allSettled([
    _fetchDuckDuckGoSignals(space, signals),
    _fetchFacebookSignals(space, signals),
  ]);

  if (signals.instagramHandle)  updates['contact.instagram'] = signals.instagramHandle;
  if (signals.facebookUrl)      updates['contact.facebook']  = signals.facebookUrl;
  if (signals.verifiedWebsite && !space.contact?.website)
    updates['contact.website'] = signals.verifiedWebsite;

  if (signals.extraPhotoUrls?.length) updates._newPhotoUrls = signals.extraPhotoUrls;

  updates._stageData = signals;
  return updates;
}

async function _fetchDuckDuckGoSignals(space, signals) {
  const name = space.name;
  const city = space.city || space.areaName || '';
  if (!name) return;

  try {
    const ddg = require('../sources/DuckDuckGoSource');
    const result = await ddg.findOfficialDomain(name, city);
    if (!result) return;

    if (result.url && !signals.verifiedWebsite) {
      signals.verifiedWebsite = result.url;
    }

    // Parse Instagram / Facebook handles if the DDG result contains social URLs
    if (result.domain) {
      if (/instagram\.com/i.test(result.domain) && !signals.instagramHandle) {
        signals.instagramHandle = result.url;
      }
      if (/facebook\.com/i.test(result.domain) && !signals.facebookUrl) {
        signals.facebookUrl = result.url;
      }
    }
  } catch (err) {
    logger.debug(`[stage3] DuckDuckGo signals failed: ${err.message}`);
  }
}

async function _fetchInstagramSignals(space, signals) {
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
