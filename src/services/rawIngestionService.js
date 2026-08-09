'use strict';
const RawSource = require('../db/rawSourceModel');
const logger    = require('../utils/logger');

const MAX_LIVE_VERSIONS = 5;

/**
 * Write a raw source payload to raw_sources.
 * Supersedes the previous current version for the same (source, sourceId).
 * Returns { rawSourceId, version }.
 */
async function ingest(source, sourceId, payload, crawlRunId, locationOpgId) {
  const latest = await RawSource.findOne({ source, sourceId, supersededAt: null })
    .sort({ version: -1 })
    .lean();

  const version = latest ? latest.version + 1 : 1;

  if (latest) {
    await RawSource.updateOne({ _id: latest._id }, { $set: { supersededAt: new Date() } });
  }

  const doc = await RawSource.create({
    source,
    sourceId,
    payload,
    version,
    crawlRunId,
    locationOpgId,
    fetchedAt:  new Date(),
    isArchived: version > MAX_LIVE_VERSIONS,
  });

  logger.debug(`[RawIngestion] ${source}:${sourceId} v${version} written`);
  return { rawSourceId: doc._id, version };
}

async function getLatest(source, sourceId) {
  return RawSource.findOne({ source, sourceId, supersededAt: null })
    .sort({ version: -1 })
    .lean();
}

// Used for crash recovery: find raw docs from a run that never produced a Space update
async function listUnprocessed(crawlRunId) {
  return RawSource.find({ crawlRunId }).lean();
}

module.exports = { ingest, getLatest, listUnprocessed };
