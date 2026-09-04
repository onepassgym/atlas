'use strict';

const Space = require('./spaceModel');
const { Review } = require('./reviewModel');
const Photo = require('./photoModel');
const PageSlug = require('./pageSlugModel');
const CrawlMeta = require('./crawlMetaModel');
const SpaceChangeLog = require('./spaceChangeLogModel');
const SpaceSource = require('./spaceSourceModel');
const EnrichmentLog = require('./enrichmentLogModel');
const CrawlJob = require('./crawlJobModel');
const logger = require('../utils/logger');

/**
 * Completely deletes a space and all its associated data across the database.
 * @param {mongoose.Types.ObjectId} spaceId 
 * @returns {Object} Count of deleted records per collection
 */
async function deleteSpaceFull(spaceId) {
  logger.info(`[DELETE] Initiating full cascade delete for spaceId: ${spaceId}`);

  // Delete all related records concurrently
  const [
    reviewsResult,
    photosResult,
    slugsResult,
    crawlMetaResult,
    logsResult,
    sourcesResult,
    enrichmentResult
  ] = await Promise.all([
    Review.deleteMany({ spaceId }),
    Photo.deleteMany({ spaceId }),
    PageSlug.deleteMany({ spaceId }),
    CrawlMeta.deleteMany({ spaceId }),
    SpaceChangeLog.deleteMany({ spaceId }),
    SpaceSource.deleteMany({ spaceId }),
    EnrichmentLog.deleteMany({ spaceId }),
  ]);

  // Pull this spaceId out of any crawl job arrays
  await CrawlJob.updateMany(
    { spaceIds: spaceId },
    { $pull: { spaceIds: spaceId } }
  );

  // Finally, delete the space itself
  const spaceResult = await Space.deleteOne({ _id: spaceId });

  const deletionStats = {
    space: spaceResult.deletedCount,
    reviews: reviewsResult.deletedCount,
    photos: photosResult.deletedCount,
    slugs: slugsResult.deletedCount,
    crawlMeta: crawlMetaResult.deletedCount,
    changeLogs: logsResult.deletedCount,
    sources: sourcesResult.deletedCount,
    enrichmentLogs: enrichmentResult.deletedCount,
  };

  logger.info(`[DELETE] Completed cascade delete for ${spaceId}. Stats: ${JSON.stringify(deletionStats)}`);
  
  return deletionStats;
}

module.exports = { deleteSpaceFull };
