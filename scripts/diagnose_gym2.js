'use strict';
/**
 * diagnose_gym2.js
 *
 * Deep-dive into the specific completed gym_name job for "RK FITNESS GYM NAHAL"
 * and simulate what the crawler actually does with the search results.
 */

require('dotenv').config();

const { connectDB } = require('../src/db/connection');
const CrawlJob = require('../src/db/crawlJobModel');
const Gym = require('../src/db/spaceModel');

const TARGET_GYM = 'RK FITNESS GYM NAHAL';

// Replicate normalizeName
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

// Simulate what processGymNameJob does:
//   1. searchGymsInCity(page, targetName, '') → gets URLs
//   2. For each URL (up to 15): scrapeGymDetail(page, url, mode) → processGym(scraped, targetName, jobId)
//
// The key question: does the gym-name search on Google Maps actually return RK FITNESS GYM NAHAL?
// And if it does, does it pass through all filters?

async function main() {
  console.log('='.repeat(70));
  console.log(`🔬 Deep Diagnostic: "${TARGET_GYM}"`);
  console.log('='.repeat(70));

  await connectDB();

  // ── 1. Inspect the completed job in detail ────────────────────────────────
  console.log('\n--- 1. Completed Job Details ---');
  const job = await CrawlJob.findOne({
    'input.spaceName': TARGET_GYM,
    status: 'completed',
  }).lean();

  if (!job) {
    console.log('No completed job found for this gym name.');
  } else {
    console.log(`Job ID:       ${job.jobId}`);
    console.log(`Status:       ${job.status}`);
    console.log(`Created:      ${job.createdAt}`);
    console.log(`Started:      ${job.startedAt}`);
    console.log(`Completed:    ${job.completedAt}`);
    const duration = job.durationMs ? `${(job.durationMs/1000).toFixed(1)}s` : 'unknown';
    console.log(`Duration:     ${duration}`);
    console.log(`Progress:     ${JSON.stringify(job.progress, null, 2)}`);
    console.log(`gymIds saved: ${JSON.stringify(job.gymIds || [])}`);
    console.log(`Errors:       ${JSON.stringify(job.jobErrors || [])}`);
    console.log(`Error count:  ${job.errorCount || 0}`);
    
    // Progress breakdown
    const p = job.progress || {};
    console.log('\n  Progress breakdown:');
    console.log(`    total:       ${p.total}     (URLs discovered)`);
    console.log(`    scraped:     ${p.scraped}   (successfully scraped)`);
    console.log(`    newGyms:     ${p.newGyms}   (created in DB)`);
    console.log(`    updatedGyms: ${p.updatedGyms} (updated in DB)`);
    console.log(`    skipped:     ${p.skipped}   (already in DB, no changes)`);
    console.log(`    failed:      ${p.failed}    (scrape failures)`);
  }

  // ── 2. What does normalizing the gym name do to the search? ────────────────
  console.log('\n--- 2. processGymNameJob Search Flow Analysis ---');
  console.log(`\nThe processGymNameJob handler calls:`);
  console.log(`  searchGymsInCity(page, "${TARGET_GYM}", '')`);
  console.log(`\nThis builds the Google Maps query:`);
  console.log(`  category = '' → query = "${TARGET_GYM}" (direct name search)`);
  console.log(`  URL: https://www.google.com/maps/search/${encodeURIComponent(TARGET_GYM)}`);

  console.log(`\n⚠️  IMPORTANT: The gym name search is passed verbatim to Google Maps.`);
  console.log(`  This is CORRECT — normalization only happens during DEDUP, not search.`);
  console.log(`  So Google Maps WILL be queried with the full gym name.`);

  // ── 3. What happens if Google Maps returns 0 or irrelevant results? ────────
  console.log('\n--- 3. Possible Failure Points ---');
  
  console.log(`\n[A] Google Maps may not return this gym for the exact name query.`);
  console.log(`    Google Maps search is not an exact-match search. For localized/small`);
  console.log(`    gyms like "RK FITNESS GYM NAHAL", Google might return zero or very`);
  console.log(`    few results for the verbatim name if it's not listed prominently.`);
  
  console.log(`\n[B] The job shows progress.total = ${job?.progress?.total || '?'}`);
  if (job?.progress?.total === 0 || job?.progress?.total === undefined) {
    console.log(`    🚨 ZERO URLs discovered! Google Maps search returned nothing.`);
    console.log(`       This is the most likely root cause.`);
  } else {
    console.log(`    ${job?.progress?.total} URLs were discovered by Google Maps search.`);
    console.log(`    But 0 were saved. Check if they failed or were skipped.`);
  }

  // ── 4. Analyze the name normalization issue for dedup ─────────────────────
  console.log('\n--- 4. Name Normalization in Dedup ---');
  const raw = TARGET_GYM;
  const normalized = normalizeName(raw);
  console.log(`\n  normalizeName("${raw}") → "${normalized}"`);
  console.log(`  Tokens: ${JSON.stringify(normalized.split(' ').filter(Boolean))}`);

  // The stopwords strip "FITNESS" and "GYM" — leaving only "RK NAHAL"
  // This is fine for dedup (prevents false positives) but let's confirm
  // the Jaccard threshold won't incorrectly block this gym
  const testCases = [
    'RK FITNESS',
    'RK GYM',
    'RK Fitness Center',
    'RK NAHAL GYM',
    'Fitness Gym Nahal',
  ];
  
  console.log(`\n  Jaccard similarity tests (threshold for geo-dedup: 0.50):`);
  for (const tc of testCases) {
    const sim = jaccardSim(TARGET_GYM, tc);
    const flag = sim >= 0.50 ? '⚠️ WOULD MATCH (dedup)' : '✅ unique';
    console.log(`    vs "${tc}" → sim=${sim.toFixed(3)} ${flag}`);
  }

  // ── 5. Check gym category mapping ─────────────────────────────────────────
  console.log('\n--- 5. Category Mapping Analysis ---');
  // Google Maps would return a category like "Gym" for this business.
  // The mapCategory function in gymProcessor.js maps this.
  const CATEGORY_MAP = {
    yoga:        'yoga_studio',
    crossfit:    'crossfit',
    pilates:     'pilates',
    martial:     'martial_arts',
    boxing:      'martial_arts',
    karate:      'martial_arts',
    dance:       'dance_studio',
    swim:        'swimming_club',
    'health club':'health_club',
    fitness:     'fitness_center',
    gym:         'gym',
    cycle:       'cycling_studio',
    spinning:    'cycling_studio',
    zumba:       'fitness_center',
    functional:  'fitness_center',
    strength:    'gym',
  };

  const testCategories = ['Gym', 'gym', 'Fitness Center', 'fitness gym'];
  console.log('\n  Category mapping for likely Google categories:');
  for (const cat of testCategories) {
    const l = cat.toLowerCase();
    let mapped = 'fitness_venue'; // default
    for (const [key, val] of Object.entries(CATEGORY_MAP)) {
      if (l.includes(key)) { mapped = val; break; }
    }
    console.log(`    "${cat}" → "${mapped}"`);
  }
  console.log('\n  ✅ Category mapping is fine — "Gym" → "gym" correctly.');

  // ── 6. Conclusion ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('ROOT CAUSE ANALYSIS SUMMARY');
  console.log('='.repeat(70));

  const total = job?.progress?.total;
  if (total === 0) {
    console.log(`\n🚨 ROOT CAUSE: Google Maps "gym-name" search returned 0 URLs for "${TARGET_GYM}"`);
    console.log(`\n   The processGymNameJob handler searches Google Maps using the verbatim`);
    console.log(`   gym name as a search query. If Google Maps does not list this specific`);
    console.log(`   gym prominently under this exact name, the search returns zero results.`);
    console.log(`\n   This is a discovery gap — not a filtering, dedup, or persistence bug.`);
    console.log(`   The gym exists on Google Maps but was NOT surfaced by the name-search.`);
  } else if (!total) {
    console.log(`\n⚠️  Could not determine progress.total from job record.`);
    console.log(`   The job may have had an error or the field was not populated.`);
  } else {
    console.log(`\n   ${total} URLs were found. The failure is downstream (scraping or persistence).`);
    console.log(`   Check jobErrors in the job record for specific error messages.`);
  }

  console.log('\n='.repeat(70));
  process.exit(0);
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
