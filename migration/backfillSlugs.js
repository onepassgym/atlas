'use strict';
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../src/db/connection');
const Space = require('../src/db/spaceModel');
const PageSlug = require('../src/db/pageSlugModel');
const { ensureUniquePageSlug } = require('../src/db/pageSlugHelper');
const logger = require('../src/utils/logger');
const slugify = require('slugify');

function slugifyValue(str) {
  if (!str) return null;
  return str.toString().toLowerCase().trim().replace(/[\s\W-]+/g, '-');
}

async function runSlugMigration() {
  await connectDB();
  logger.info('[slug migration] Fetching spaces without slugs...');

  // We could filter to only spaces that lack a PageSlug, but ensuring all is safer.
  const spaces = await Space.find().select('_id opgId name address category').lean();
  logger.info(`[slug migration] Found ${spaces.length} spaces to verify/backfill.`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < spaces.length; i++) {
    const space = spaces[i];
    try {
      const baseSlug = slugifyValue(space.name) || `space-${space._id}`;
      await ensureUniquePageSlug(
        baseSlug,
        space._id,
        space.opgId,
        space.name,
        space.address,
        space.category
      );
      success++;
    } catch (e) {
      logger.error(`[slug migration] Failed for space ${space._id}: ${e.message}`);
      failed++;
    }

    if (i > 0 && i % 100 === 0) {
      logger.info(`[slug migration] Processed ${i} / ${spaces.length}...`);
    }
  }

  logger.info(`[slug migration] Finished! Successfully generated/verified slugs for ${success} spaces. Failed: ${failed}.`);
  await disconnectDB();
}

if (require.main === module) {
  runSlugMigration().then(() => process.exit(0)).catch(e => {
    logger.error(`Migration crashed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = runSlugMigration;
