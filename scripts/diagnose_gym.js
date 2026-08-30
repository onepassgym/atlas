'use strict';
/**
 * diagnose_gym.js
 * 
 * Traces the full crawling flow for "RK FITNESS GYM NAHAL" without
 * making any changes to the implementation.
 *
 * Usage:
 *   node scripts/diagnose_gym.js
 */

require('dotenv').config();

const { connectDB } = require('../src/db/connection');
const Gym = require('../src/db/spaceModel');
const CrawlJob = require('../src/db/crawlJobModel');
const SpaceSource = require('../src/db/spaceSourceModel');

const TARGET_GYM = 'RK FITNESS GYM NAHAL';

// ── Replicate normalizeName from dedup.js / upsertGym.js ─────────────────────
function normalizeName(name = '') {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(gym|fitness|studio|centre|center|club|the|and|&|pvt|ltd|inc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSim(a, b) {
  const sa = new Set(normalizeName(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeName(b).split(' ').filter(Boolean));
  const inter = new Set([...sa].filter(x => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return union.size === 0 ? 0 : inter.size / union.size;
}

// ── Check searchGymsInCity query URL ─────────────────────────────────────────
function getSearchUrl(targetName, category = '') {
  const query = category ? `${category} in ${targetName}` : targetName;
  return {
    query,
    url: `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
  };
}

// ── Trace skipRecentDays pre-filter ──────────────────────────────────────────
const SKIP_RECENT_DAYS = parseInt(process.env.SCRAPER_SKIP_RECENT_DAYS || '7', 10);

async function checkPreFilter(gymName) {
  const cutoff = new Date(Date.now() - SKIP_RECENT_DAYS * 86_400_000);
  console.log(`\n[PreFilter] SKIP_RECENT_DAYS=${SKIP_RECENT_DAYS} → cutoff: ${cutoff.toISOString()}`);

  // Look for this gym by name pattern
  const gyms = await Gym.find({
    name: { $regex: new RegExp(gymName.split(' ').slice(0, 3).join(' '), 'i') },
  }).lean();

  if (!gyms.length) {
    console.log(`[PreFilter] No existing gym found matching "${gymName}"`);
  } else {
    for (const g of gyms) {
      const lastCrawledAt = g.crawl?.lastCrawledAt || g.crawlMeta?.lastCrawledAt;
      const wouldBeSkipped = lastCrawledAt && new Date(lastCrawledAt) >= cutoff;
      console.log(`[PreFilter] Found: "${g.name}" | lastCrawledAt: ${lastCrawledAt || 'none'} | wouldBeSkipped: ${wouldBeSkipped}`);
    }
  }
  return gyms;
}

// ── Check dedup logic for this gym ───────────────────────────────────────────
async function checkDedup(gymName) {
  console.log(`\n[Dedup] Checking Jaccard similarity for "${gymName}" against DB entries...`);
  const normalized = normalizeName(gymName);
  console.log(`[Dedup]   normalizeName("${gymName}") → "${normalized}"`);

  // Find some gyms in the DB to test similarity
  const sample = await Gym.find({}).limit(20).lean();
  const relevant = sample.filter(g => {
    const sim = jaccardSim(gymName, g.name);
    return sim > 0.1;
  });

  if (!relevant.length) {
    console.log(`[Dedup]   No similar gyms found in DB (sample of 20)`);
  } else {
    for (const g of relevant) {
      const sim = jaccardSim(gymName, g.name);
      console.log(`[Dedup]   "${g.name}" → sim=${sim.toFixed(3)} (threshold: 0.50 for geo-match)`);
    }
  }

  // Check exact slug that would be generated
  const slugify = require('slugify');
  const slug = slugify(`${gymName} `, { lower: true, strict: true });
  console.log(`\n[Dedup]   Slug that would be generated: "${slug}"`);
  const bySlug = await Gym.findOne({ slug }).lean();
  if (bySlug) {
    console.log(`[Dedup]   ⚠️  Slug already exists in DB! gym: "${bySlug.name}"`);
  } else {
    console.log(`[Dedup]   Slug is unique — no collision.`);
  }
}

// ── Inspect FITNESS_CATEGORIES and search query ───────────────────────────────
function analyzeSearchQuery() {
  const FITNESS_CATEGORIES = [
    'gym',
    'fitness center',
    'yoga studio',
    'crossfit',
    'pilates studio',
    'martial arts gym',
    'boxing gym',
    'dance fitness studio',
    'personal training studio',
    'swimming club',
  ];

  console.log(`\n[SearchQuery] City-crawl approach uses these queries (if crawling by city/region):`);
  // The gym is named "RK FITNESS GYM NAHAL" — it likely has "gym" or "fitness" in its name
  // which means it should appear in results for 'gym in <city>' or 'fitness center in <city>'

  // For gym-name crawl: query is just the gym name (category='')
  const { query, url } = getSearchUrl(TARGET_GYM, '');
  console.log(`\n[SearchQuery] Gym-name crawl query: "${query}"`);
  console.log(`[SearchQuery] URL: ${url}`);

  // For city-crawl: each category produces a different query
  console.log(`\n[SearchQuery] City-crawl category queries that would capture this gym:`);
  for (const cat of FITNESS_CATEGORIES) {
    // The gym is in "Nahal" — if the city name was "Nahal" or a region containing it, these queries would run
    // But we don't know what city name was used. Let's just show the pattern.
    console.log(`  - "${cat} in <cityName>" → would include any gym matching this category`);
  }

  // The key question: Does "RK FITNESS GYM NAHAL" appear in Google Maps results
  // for any of these categories?
  console.log(`\n[SearchQuery] ⚠️  The gym name contains "FITNESS" and "GYM" — it should appear in:`);
  console.log(`  - "gym in <Nahal city>" search`);
  console.log(`  - "fitness center in <Nahal city>" search`);
  console.log(`  — IF the correct city/region is being crawled`);

  return FITNESS_CATEGORIES;
}

// ── Check active/recent jobs ──────────────────────────────────────────────────
async function checkJobs() {
  console.log(`\n[Jobs] Checking recent crawl jobs...`);
  const jobs = await CrawlJob.find({}).sort({ createdAt: -1 }).limit(10).lean();
  
  if (!jobs.length) {
    console.log(`[Jobs]   No jobs found in DB`);
    return;
  }

  for (const j of jobs) {
    const cityOrName = j.input?.cityName || j.input?.spaceName || j.input?.regionName || '?';
    console.log(`[Jobs]   [${j.status}] ${j.type} | "${cityOrName}" | created: ${j.createdAt?.toISOString?.() || j.createdAt}`);
    
    // Check if any job crawled Nahal or similar
    const nameLower = cityOrName.toLowerCase();
    if (nameLower.includes('nahal') || nameLower.includes('rk fitness') || nameLower.includes('nahal')) {
      console.log(`[Jobs]     ⬆️  THIS JOB IS RELEVANT TO THE TARGET GYM`);
    }
  }
}

// ── Check if the gym exists at all ───────────────────────────────────────────
async function checkGymInDB() {
  console.log(`\n[DB] Searching for "${TARGET_GYM}" in database...`);
  
  // Try various searches
  const searches = [
    { name: { $regex: /rk fitness/i } },
    { name: { $regex: /nahal/i } },
    { areaName: { $regex: /nahal/i } },
  ];

  let found = false;
  for (const filter of searches) {
    const results = await Gym.find(filter).limit(5).lean();
    if (results.length) {
      found = true;
      console.log(`[DB] Filter: ${JSON.stringify(filter)} → Found ${results.length} result(s):`);
      for (const r of results) {
        console.log(`  - "${r.name}" | area: ${r.areaName} | address: ${r.address}`);
        console.log(`    lastCrawledAt: ${r.crawl?.lastCrawledAt || r.crawlMeta?.lastCrawledAt || 'never'}`);
      }
    }
  }

  if (!found) {
    console.log(`[DB] Gym NOT found in database — it was never successfully crawled`);
  }
}

// ── Main diagnostic ───────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log(`🔍 Atlas Crawl Diagnostic: "${TARGET_GYM}"`);
  console.log('='.repeat(60));

  await connectDB();

  // 1. Check if gym exists in DB
  await checkGymInDB();

  // 2. Analyze search query construction  
  analyzeSearchQuery();

  // 3. Check Jaccard dedup
  await checkDedup(TARGET_GYM);

  // 4. Check pre-filter (skip-recent-days)
  await checkPreFilter(TARGET_GYM);

  // 5. Check job history
  await checkJobs();

  // 6. Normalization deep-dive
  console.log('\n[Normalization] Deep-dive on gym name processing:');
  console.log(`  Raw name:    "${TARGET_GYM}"`);
  const normalized = normalizeName(TARGET_GYM);
  console.log(`  Normalized:  "${normalized}"`);
  const tokens = normalized.split(' ').filter(Boolean);
  console.log(`  Tokens:      ${JSON.stringify(tokens)}`);
  console.log(`\n  ⚠️  After normalization, "RK FITNESS GYM NAHAL" becomes "${normalized}"`);
  if (!tokens.length || (tokens.length === 1 && tokens[0] === 'rk')) {
    console.log(`  🚨 CRITICAL: Normalization strips almost all meaningful tokens!`);
    console.log(`     "FITNESS" → stripped (stops list includes "fitness")`);
    console.log(`     "GYM"     → stripped (stops list includes "gym")`);
    console.log(`     "NAHAL"   → kept (not in stops list)`);
    console.log(`     "RK"      → kept (not in stops list)`);
    console.log(`  This means Jaccard similarity with near-matches would be low.`);
  }

  // 7. Simulate Jaccard sim with a similar name
  const similar = 'RK Fitness';
  const sim = jaccardSim(TARGET_GYM, similar);
  console.log(`\n[Jaccard] jaccardSim("${TARGET_GYM}", "${similar}") = ${sim.toFixed(3)}`);
  
  const sim2 = jaccardSim(TARGET_GYM, 'RK Gym Nahal');
  console.log(`[Jaccard] jaccardSim("${TARGET_GYM}", "RK Gym Nahal") = ${sim2.toFixed(3)}`);

  console.log('\n' + '='.repeat(60));
  console.log('Diagnostic complete.');
  console.log('='.repeat(60));

  process.exit(0);
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
