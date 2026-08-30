'use strict';
/**
 * Usage:
 *   node scripts/queueRegions.js --file scripts/regions-example.json
 */
require('dotenv').config();
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { connectDB, disconnectDB } = require('../src/db/connection');
const { addGridJob } = require('../src/queue/queues');
const CrawlJob = require('../src/db/crawlJobModel');
const { generateGrid } = require('../src/utils/grid');
const { FITNESS_CATEGORIES } = require('../src/scraper/googleMapsScraper');
const logger = require('../src/utils/logger');

async function main() {
  await connectDB();

  const args = process.argv.slice(2);
  let list = [];

  const fi = args.indexOf('--file');

  if (fi !== -1 && args[fi + 1]) {
    list = JSON.parse(fs.readFileSync(args[fi + 1], 'utf-8'));
  } else {
    console.error('Usage:');
    console.error('  node scripts/queueRegions.js --file scripts/regions-example.json');
    process.exit(1);
  }

  logger.info(`Queuing grid jobs for ${list.length} regions...`);

  let totalJobsQueued = 0;

  for (const item of list) {
    const regionName = item.name;
    const bounds = item.bounds;
    const stepKm = item.stepKm || 5;
    const zoom = item.zoom || 14;
    const categories = item.categories || FITNESS_CATEGORIES;
    
    if (!bounds || !bounds.north || !bounds.south || !bounds.east || !bounds.west) {
      logger.error(`  ❌ Invalid bounds for region ${regionName}`);
      continue;
    }

    const gridPoints = generateGrid(bounds, stepKm);
    logger.info(`  Generated ${gridPoints.length} grid points for ${regionName} (step: ${stepKm}km)`);

    for (const point of gridPoints) {
      const jobId = uuidv4();
      await CrawlJob.create({ jobId, type: 'grid', input: { regionName, lat: point.lat, lng: point.lng, zoom, categories }, status: 'queued' });
      await addGridJob(jobId, regionName, point.lat, point.lng, zoom, categories);
      totalJobsQueued++;
    }
    
    logger.info(`  ✅ Queued ${gridPoints.length} jobs for region: ${regionName}`);
  }

  logger.info(`\nAll ${totalJobsQueued} grid jobs queued across ${list.length} regions.`);
  await disconnectDB();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
