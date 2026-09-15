'use strict';

const CrawlJob = require('../db/crawlJobModel');
const { getQueueJobStatus } = require('../queue/queues');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

/**
 * Reconciles orphaned crawl jobs on startup.
 * If a job in MongoDB is marked as 'running' but BullMQ has no active job
 * executing it, it indicates the worker or server crashed while the job was active.
 * Marking it 'failed' clears active job locks so new crawls aren't blocked.
 */
async function reconcileOrphanedJobs() {
  try {
    const runningJobs = await CrawlJob.find({ status: 'running' }).lean();

    let reconciled = 0;
    if (runningJobs && runningJobs.length > 0) {
      for (const job of runningJobs) {
        const qStatus = await getQueueJobStatus(job.jobId);
        // If the queue job does not exist or is not in active state, it's orphaned
        if (!qStatus || qStatus.state !== 'active') {
          const duration = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;
          await CrawlJob.updateOne(
            { jobId: job.jobId },
            {
              status: 'failed',
              completedAt: new Date(),
              durationMs: duration,
              $push: {
                jobErrors: {
                  message: 'Job interrupted: worker process terminated or crashed while job was running',
                  at: new Date(),
                },
              },
            }
          );
          logger.warn(`🧹 Reconciled orphaned running job: ${job.jobId} (${job.input?.cityName || job.input?.spaceName || 'unknown'})`);
          reconciled++;
        }
      }
    }

    // Clean up any stale running jobs in legacy gym_crawl_jobs if collection exists
    try {
      const db = mongoose.connection.db;
      if (db) {
        const legacyCols = await db.listCollections({ name: 'gym_crawl_jobs' }).toArray();
        if (legacyCols.length > 0) {
          const res = await db.collection('gym_crawl_jobs').updateMany(
            { status: 'running' },
            {
              $set: {
                status: 'failed',
                completedAt: new Date(),
              },
              $push: {
                jobErrors: {
                  message: 'Legacy job interrupted before migration',
                  at: new Date(),
                },
              },
            }
          );
          if (res.modifiedCount > 0) {
            logger.info(`🧹 Cleaned up ${res.modifiedCount} legacy gym_crawl_jobs running entry.`);
          }
        }
      }
    } catch (_) {}

    if (reconciled > 0) {
      logger.info(`🧹 Successfully reconciled ${reconciled} orphaned running job(s).`);
    }
    return reconciled;
  } catch (err) {
    logger.error(`Failed to reconcile orphaned jobs: ${err.message}`);
    return 0;
  }
}

module.exports = {
  reconcileOrphanedJobs,
};
