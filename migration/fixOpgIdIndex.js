'use strict';
/**
 * One-time fix: ensureIndexes.js wants `spaces.opgId_1` to be a unique+sparse
 * index named `opgId_unique`, but an older index on the same {opgId:1} key
 * already exists under a different name (MongoDB refuses to rename in place —
 * createIndex with a new name but the same key pattern fails with
 * "Index already exists with a different name", which connection.js logs as a
 * non-fatal warning and otherwise ignores).
 *
 * This inspects every index on {opgId:1} across the opgId-bearing collections,
 * and — only for ones that don't already match the unique+sparse spec
 * ensureIndexes.js wants — drops and recreates them under the canonical name.
 * Read-only if everything already matches.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../src/db/connection');
const cfg = require('../config');
const logger = require('../src/utils/logger');

const TARGETS = [
  { coll: cfg.collections.spaces, spec: { unique: true, sparse: true }, name: 'opgId_unique' },
];

async function run() {
  // connectDB() runs the full ensureIndexes() sweep on connect and only warns
  // on conflicts (see src/db/connection.js), so any unrelated stale index
  // elsewhere in the DB can't abort this script.
  await connectDB();
  const db = mongoose.connection.db;

  for (const target of TARGETS) {
    const collection = db.collection(target.coll);
    const indexes = await collection.indexes();
    const onOpgId = indexes.filter(ix => Object.keys(ix.key).length === 1 && ix.key.opgId === 1);

    logger.info(`[fixOpgIdIndex] ${target.coll}: found ${onOpgId.length} index(es) on {opgId:1} → ${JSON.stringify(onOpgId.map(ix => ({ name: ix.name, unique: !!ix.unique, sparse: !!ix.sparse })))}`);

    const matchesTarget = ix =>
      ix.name === target.name && !!ix.unique === !!target.spec.unique && !!ix.sparse === !!target.spec.sparse;

    if (onOpgId.some(matchesTarget)) {
      logger.info(`[fixOpgIdIndex] ${target.coll}: canonical index "${target.name}" already correct. Nothing to do.`);
      continue;
    }

    for (const ix of onOpgId) {
      logger.info(`[fixOpgIdIndex] ${target.coll}: dropping stale index "${ix.name}" (unique=${!!ix.unique}, sparse=${!!ix.sparse})`);
      await collection.dropIndex(ix.name);
    }

    // Recreate only this specific index — not the whole ensureIndexes() sweep —
    // so an unrelated stale index elsewhere can't block this fix.
    logger.info(`[fixOpgIdIndex] ${target.coll}: creating canonical index "${target.name}"...`);
    await collection.createIndex({ opgId: 1 }, { ...target.spec, name: target.name });
    logger.info(`[fixOpgIdIndex] ${target.coll}: done.`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(e => {
  logger.error('[fixOpgIdIndex] Failed: ' + e.message);
  process.exit(1);
});
