'use strict';
const { v4: uuidv4 }  = require('uuid');
const CrawlRun        = require('../db/crawlRunModel');
const sessionMgr      = require('../scraper/sessionManager');
const cbService       = require('./circuitBreaker');
const obsv            = require('./observabilityService');
const logger          = require('../utils/logger');

// Lazy-require source adapters to avoid circular dependency issues at module load
function getOSM()      { return require('../scraper/sources/OSMSource'); }
function getJD()       { return require('../scraper/sources/JustDialSource'); }
function getGM()       { return require('../scraper/sources/GoogleMapsSource'); }

const GEO_TOLERANCE_M = 50; // metres within which two candidates are considered the same point

function haversineMeters(a, b) {
  const R = 6_371_000;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const c = 2 * Math.atan2(
    Math.sqrt(sinLat * sinLat + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * sinLon * sinLon),
    Math.sqrt(1 - sinLat * sinLat - Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * sinLon * sinLon),
  );
  return R * c;
}

/** Light dedup before entity resolution: collapse identical placeIds and near-duplicate coords+name. */
function deduplicateCandidates(results) {
  const seenPlaceIds = new Set();
  const kept = [];

  for (const r of results) {
    if (r.placeId) {
      if (seenPlaceIds.has(r.placeId)) continue;
      seenPlaceIds.add(r.placeId);
    }

    // Check coord proximity against already-kept results
    const coords = r.location?.coordinates; // [lng, lat]
    if (coords) {
      const nameLower = (r.name || '').toLowerCase();
      const nearDup = kept.find(k => {
        const kc = k.location?.coordinates;
        if (!kc) return false;
        const dist = haversineMeters(coords, kc);
        return dist < GEO_TOLERANCE_M && (k.name || '').toLowerCase() === nameLower;
      });
      if (nearDup) continue;
    }

    kept.push(r);
  }

  return kept;
}

/**
 * Run the full multi-source discovery for a seed.
 * OSM + JustDial always run. Google Maps runs only when available (circuit closed, no cooling).
 *
 * @param {{ locationOpgId, cityName, categorySlugs, crawlJobId? }} seed
 * @returns {{ candidates: RawSpaceResult[], crawlRunId: ObjectId }}
 */
async function discover(seed) {
  const runId  = uuidv4();
  const run    = await CrawlRun.create({
    runId,
    crawlJobId:    seed.crawlJobId || undefined,
    locationOpgId: seed.locationOpgId,
    categorySlug:  (seed.categorySlugs || [])[0] || 'gym',
    source:        'multi',
    startedAt:     new Date(),
  });

  const allRaw   = [];
  const httpStats = {
    blockDetectedCount: 0,
    sessionRotations:   0,
    s403Count:          0,
    s429Count:          0,
    s5xxCount:          0,
    timeouts:           0,
    emptyPageCount:     0,
  };

  // ── OSM — always runs, never blocked ─────────────────────────────────────
  try {
    const osm     = getOSM();
    const results = await osm.searchByArea(seed.cityName, seed.categorySlugs || []);
    allRaw.push(...results);
    logger.info(`[Discovery] OSM: ${results.length} candidates for ${seed.cityName}`);
  } catch (err) {
    logger.warn(`[Discovery] OSM failed for ${seed.cityName}: ${err.message}`);
    httpStats.timeouts++;
  }

  // ── JustDial — always runs ────────────────────────────────────────────────
  try {
    const jd      = getJD();
    const results = await jd.searchByArea(seed.cityName, seed.categorySlugs || []);
    allRaw.push(...results);
    logger.info(`[Discovery] JustDial: ${results.length} candidates for ${seed.cityName}`);
  } catch (err) {
    logger.warn(`[Discovery] JustDial failed for ${seed.cityName}: ${err.message}`);
    if (/403/.test(err.message))  httpStats.s403Count++;
    else if (/429/.test(err.message)) httpStats.s429Count++;
    else httpStats.timeouts++;
  }

  // ── Google Maps — conditional on session availability ─────────────────────
  if (await sessionMgr.isAvailable()) {
    await sessionMgr.markSessionLaunched();
    httpStats.sessionRotations++;

    try {
      const gm      = getGM();
      const results = await gm.searchByArea(seed.cityName, seed.categorySlugs || []);
      allRaw.push(...results);
      logger.info(`[Discovery] Google Maps: ${results.length} candidates for ${seed.cityName}`);
    } catch (err) {
      const msg = err.message || '';
      if (/blocked|captcha/i.test(msg)) {
        httpStats.blockDetectedCount++;
        logger.warn(`[Discovery] Google Maps blocked for ${seed.cityName}`);
        // sessionManager.reportBlock() is already called inside isBlocked()
      } else if (/403/.test(msg)) {
        httpStats.s403Count++;
      } else if (/429/.test(msg)) {
        httpStats.s429Count++;
      } else {
        httpStats.timeouts++;
      }
      logger.warn(`[Discovery] Google Maps error for ${seed.cityName}: ${msg}`);
    }
  } else {
    logger.info(`[Discovery] Google Maps skipped for ${seed.cityName} — circuit open or cooling`);
  }

  const candidates = deduplicateCandidates(allRaw);
  const finishedAt = new Date();

  await CrawlRun.updateOne({ runId }, {
    $set: {
      finishedAt,
      durationMs:   finishedAt - run.startedAt,
      recordsFound: candidates.length,
      recordsRaw:   allRaw.length,
      httpStats,
    },
  });

  await obsv.checkRegression(runId);

  return { candidates, crawlRunId: run._id };
}

module.exports = { discover };
