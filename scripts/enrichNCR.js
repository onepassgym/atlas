#!/usr/bin/env node
'use strict';
/**
 * scripts/enrichNCR.js
 *
 * Queries all gyms in the NCR cities (Delhi, Noida, Gurugram, Ghaziabad,
 * Meerut, Hapur, Bulandshahr) and enqueues gym-enrichment BullMQ jobs
 * in the atlas-enrichment queue at priority 2.
 *
 * Usage:
 *   node scripts/enrichNCR.js                    # enqueue all NCR gyms
 *   node scripts/enrichNCR.js --city Delhi        # single city
 *   node scripts/enrichNCR.js --limit 100         # cap total jobs
 *   node scripts/enrichNCR.js --dry-run           # print counts, no enqueue
 *
 * Cities are queued in priority order (Delhi first → Bulandshahr last).
 * Batch size: ENRICHMENT_BATCH_SIZE (default 50) — each gym is one job.
 */

require('dotenv').config();

const { connectDB }      = require('../src/db/connection');
const Gym                = require('../src/db/gymModel');
const { addEnrichmentJob } = require('../src/queue/queues');
const logger             = require('../src/utils/logger');

// NCR cities in enrichment priority order
const NCR_CITIES = [
  'Delhi',
  'Noida',
  'Gurugram',
  'Ghaziabad',
  'Meerut',
  'Hapur',
  'Bulandshahr',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { city: null, limit: Infinity, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--city'    && args[i + 1]) { opts.city    = args[++i]; }
    if (args[i] === '--limit'   && args[i + 1]) { opts.limit   = parseInt(args[++i], 10); }
    if (args[i] === '--dry-run')                 { opts.dryRun  = true; }
  }
  return opts;
}

async function getGymsForCity(cityName) {
  return Gym.find(
    {
      // Match areaName containing the city (case-insensitive)
      areaName: { $regex: new RegExp(cityName, 'i') },
      // Must have a googleMapsUrl to navigate to
      googleMapsUrl: { $exists: true, $ne: null },
    },
    { _id: 1, googleMapsUrl: 1, name: 1, areaName: 1 }
  ).lean();
}

async function main() {
  const opts = parseArgs();
  const citiesToProcess = opts.city
    ? NCR_CITIES.filter(c => c.toLowerCase() === opts.city.toLowerCase())
    : NCR_CITIES;

  if (opts.city && citiesToProcess.length === 0) {
    console.error(`❌ Unknown city: "${opts.city}". Valid: ${NCR_CITIES.join(', ')}`);
    process.exit(1);
  }

  await connectDB();
  logger.info(`\n✨ NCR Enrichment Queuer`);
  logger.info(`   Cities: ${citiesToProcess.join(', ')}`);
  logger.info(`   Limit:  ${opts.limit === Infinity ? 'none' : opts.limit}`);
  logger.info(`   Mode:   ${opts.dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  let totalQueued = 0;
  let totalSkipped = 0;

  for (const city of citiesToProcess) {
    if (totalQueued >= opts.limit) break;

    const gyms = await getGymsForCity(city);
    logger.info(`🏙  ${city}: ${gyms.length} gyms found`);

    let cityQueued = 0;
    for (const gym of gyms) {
      if (totalQueued >= opts.limit) { totalSkipped += gyms.length - cityQueued; break; }

      if (!opts.dryRun) {
        try {
          await addEnrichmentJob(gym._id, gym.googleMapsUrl, city);
          cityQueued++;
          totalQueued++;
        } catch (err) {
          logger.warn(`  ⚠  Failed to queue gym ${gym._id} (${gym.name}): ${err.message}`);
          totalSkipped++;
        }
      } else {
        cityQueued++;
        totalQueued++;
      }

      // Progress log every 50 jobs
      if (cityQueued % 50 === 0) {
        logger.info(`  ... ${cityQueued}/${gyms.length} queued for ${city}`);
      }
    }

    logger.info(`  ✅ ${city}: queued ${cityQueued} enrichment jobs`);
  }

  logger.info(`\n─────────────────────────────────────────────`);
  logger.info(`  Total queued:  ${totalQueued}`);
  logger.info(`  Total skipped: ${totalSkipped}`);
  if (opts.dryRun) logger.info(`  (DRY RUN — no jobs were actually enqueued)`);
  logger.info(`─────────────────────────────────────────────\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('enrichNCR.js error:', err);
  process.exit(1);
});
