'use strict';
/**
 * test_search.js
 *
 * Runs the ACTUAL searchGymsInCity for "RK FITNESS GYM NAHAL"
 * to see exactly what Google Maps returns, and then tests
 * alternative search strategies.
 *
 * Usage:
 *   SCRAPER_HEADLESS=false node scripts/test_search.js
 */

require('dotenv').config();
const { BrowserManager, searchGymsInCity, FITNESS_CATEGORIES } = require('../src/scraper/googleMapsScraper');
const logger = require('../src/utils/logger');

const TARGET_GYM = 'RK FITNESS GYM NAHAL';

// Alternative search strategies to test
const ALT_STRATEGIES = [
  // Strategy 1: Use just the first few words (shorter name)
  'RK FITNESS NAHAL',
  // Strategy 2: Drop "GYM" (it may be generic noise)
  'RK FITNESS NAHAL',
  // Strategy 3: Use a category + location
  'gym in Nahal',
  'fitness gym Nahal',
];

async function testSearch(browser, queryName, category = '') {
  const page = await browser.newPage();
  const query = category ? `${category} in ${queryName}` : queryName;
  logger.info(`\n🔍 Testing: "${query}"`);
  
  try {
    const urls = await searchGymsInCity(page, queryName, category);
    logger.info(`   → Found ${urls.length} URLs`);
    if (urls.length > 0) {
      logger.info(`   → First 5 URLs:`);
      urls.slice(0, 5).forEach((u, i) => {
        const name = decodeURIComponent(u.split('/maps/place/')[1] || '').split('/')[0];
        logger.info(`     [${i+1}] ${name}`);
      });
    }
    return { query, urls };
  } catch (err) {
    logger.error(`   → ERROR: ${err.message}`);
    return { query, urls: [], error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  logger.info('='.repeat(60));
  logger.info(`🧪 Live Search Test: "${TARGET_GYM}"`);
  logger.info('='.repeat(60));

  const browser = new BrowserManager();
  const results = [];

  try {
    await browser.launch();

    // Test 1: Exact name search (what gym-name crawl does)
    const r1 = await testSearch(browser, TARGET_GYM, '');
    results.push(r1);

    // Test 2: Shorter name variants
    const page2 = await browser.newPage();
    const urls2 = await searchGymsInCity(page2, 'RK FITNESS NAHAL', '');
    logger.info(`\n🔍 Alt query "RK FITNESS NAHAL" → ${urls2.length} URLs`);
    results.push({ query: 'RK FITNESS NAHAL', urls: urls2 });
    await page2.close().catch(() => {});

    // Test 3: Category search in the city/area
    const page3 = await browser.newPage();
    const urls3 = await searchGymsInCity(page3, 'Nahal', 'gym');
    logger.info(`\n🔍 Category query "gym in Nahal" → ${urls3.length} URLs`);
    if (urls3.length > 0) {
      logger.info(`   URLs found:`);
      urls3.slice(0, 10).forEach((u, i) => {
        const name = decodeURIComponent(u.split('/maps/place/')[1] || '').split('/')[0];
        logger.info(`   [${i+1}] ${name}`);
      });
      // Check if our gym appears
      const found = urls3.some(u => u.toLowerCase().includes('rk') || u.toLowerCase().includes('nahal'));
      logger.info(`   RK FITNESS GYM NAHAL found in results: ${found}`);
    }
    results.push({ query: 'gym in Nahal', urls: urls3 });
    await page3.close().catch(() => {});

  } finally {
    await browser.close();
  }

  logger.info('\n' + '='.repeat(60));
  logger.info('SEARCH TEST RESULTS:');
  logger.info('='.repeat(60));
  
  for (const r of results) {
    logger.info(`\n"${r.query}" → ${r.urls.length} URLs found`);
    if (r.error) logger.info(`  ERROR: ${r.error}`);
  }

  const originalFound = results[0]?.urls?.length || 0;
  if (originalFound === 0) {
    logger.info('\n🚨 CONFIRMED: Original gym-name search returns 0 results.');
    logger.info('   Alternative strategies that work:');
    for (const r of results.slice(1)) {
      if (r.urls.length > 0) {
        logger.info(`   ✅ "${r.query}" → ${r.urls.length} URLs`);
      }
    }
  }

  process.exit(0);
}

main().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
