'use strict';
require('dotenv').config();
const { connectDB } = require('../src/db/connection');
const { migrateSeedsFromScheduleConfig } = require('../src/services/seedService');
const Space = require('../src/db/spaceModel');
const logger = require('../src/utils/logger');

async function run() {
  await connectDB();

  // 1. Migrate cities from schedule.json into crawl_seeds
  const seeded = await migrateSeedsFromScheduleConfig();
  logger.info(`Seeds migrated: ${seeded}`);

  // 2. Backfill validationState on all existing Space documents
  const [validated, draft, archived] = await Promise.all([
    Space.updateMany(
      { 'enrichment.stage': 7, deletedAt: null, $or: [{ validationState: null }, { validationState: { $exists: false } }, { validationState: 'raw' }] },
      { $set: { validationState: 'validated' } }
    ),
    Space.updateMany(
      { 'enrichment.stage': { $lt: 7 }, deletedAt: null, $or: [{ validationState: null }, { validationState: { $exists: false } }, { validationState: 'raw' }] },
      { $set: { validationState: 'draft' } }
    ),
    Space.updateMany(
      { deletedAt: { $ne: null }, $or: [{ validationState: null }, { validationState: { $exists: false } }, { validationState: 'raw' }] },
      { $set: { validationState: 'archived' } }
    ),
  ]);

  logger.info(`validationState backfill: ${validated.modifiedCount} validated, ${draft.modifiedCount} draft, ${archived.modifiedCount} archived`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
