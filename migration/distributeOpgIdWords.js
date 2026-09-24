'use strict';
/**
 * One-time migration: opgId generation used to exhaust the entire HEX_BLOCK_SIZE
 * (65536) range for the first word ("HAWK") before ever moving on to the next
 * word in config/opgWords.json. src/utils/opgId.js now cycles through the whole
 * catalog round-robin instead, so every animal name appears quickly.
 *
 * Changing the sequence->word/hex formula alone would risk a future ID colliding
 * with an already-issued "OPG-HAWK-XXXX" id (both formulas draw from the same
 * counter space, and only HAWK was ever used under the old scheme). This bumps
 * the persisted OPG counter to `oldCounter * WORDS.length`, which guarantees the
 * next HAWK slot the new formula reaches is `hex = oldCounter` — one past the
 * highest hex ever issued — so no collision is possible. It is idempotent: it
 * records a `distributedAt` flag and does nothing on a second run.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../src/db/connection');
const { COUNTER_COLLECTION } = require('../src/utils/opgId');
const WORDS = require('../config/opgWords.json');
const logger = require('../src/utils/logger');

async function run() {
  await connectDB();
  const db = mongoose.connection.db;
  const counters = db.collection(COUNTER_COLLECTION);

  const existing = await counters.findOne({ prefix: 'OPG' });
  if (!existing) {
    logger.info('No OPG counter found yet — nothing to migrate.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (existing.distributedAt) {
    logger.info(`OPG counter already distributed at ${existing.distributedAt.toISOString()}. Nothing to do.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const oldValue = existing.value || 0;
  const newValue = oldValue * WORDS.length;
  const now = new Date();

  const result = await counters.findOneAndUpdate(
    { prefix: 'OPG', distributedAt: { $exists: false } },
    { $set: { value: newValue, distributedAt: now, updatedAt: now } },
    { returnDocument: 'after' }
  );

  const doc = result?.value?.value !== undefined ? result.value : result;
  if (!doc) {
    logger.info('Counter was migrated concurrently by another run. Nothing to do.');
  } else {
    logger.info(`OPG counter bumped from ${oldValue} to ${newValue} (x${WORDS.length} words) — future ids are collision-safe with any previously issued OPG-HAWK-* id.`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(e => {
  logger.error('Migration failed: ' + e.message);
  process.exit(1);
});
