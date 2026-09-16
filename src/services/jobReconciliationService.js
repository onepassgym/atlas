'use strict';

const CrawlJob = require('../db/crawlJobModel');
const { getQueueJobStatus, hasPendingBatchJobs } = require('../queue/queues');
const logger = require('../utils/logger');
const bus = require('../services/eventBus');
const mongoose = require('mongoose');

/**
 * Reconciles orphaned crawl jobs on startup.
 * If a job in MongoDB is marked as 'running' but BullMQ has no active job
 * executing it, it indicates the worker or server crashed while the job was active.
 * Marking it 'failed' clears active job locks so new crawls aren't blocked.
 *
 * City/grid jobs are more subtle: their discovery job (BullMQ job `jobId`)
 * completes as soon as it enqueues batch-scrape children — it is NOT active
 * for the whole lifetime of the crawl. So "discovery job isn't active" alone
 * does not mean the job is orphaned; batch-scrape children may still be
 * running on this or another worker replica. We only declare a job orphaned
 * once we've confirmed no batch children are pending/active either.
 */
async function reconcileOrphanedJobs() {
  try {
    const runningJobs = await CrawlJob.find({ status: 'running' }).lean();

    let reconciled = 0;
    let resumed = 0;
    if (runningJobs && runningJobs.length > 0) {
      for (const job of runningJobs) {
        const qStatus = await getQueueJobStatus(job.jobId);
        if (qStatus && qStatus.state === 'active') continue; // discovery phase still genuinely running

        const p = job.progress || {};
        if (p.batches > 0) {
          const stillBatching = await hasPendingBatchJobs(job.jobId);
          if (stillBatching) continue; // batch-scrape children still in flight elsewhere

          // No batch children left in the queue. If they all reported in before
          // the crash, the job actually finished — reconcile as completed, not
          // failed, so it isn't misreported and doesn't block re-crawls.
          const totalDone = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);
          const isComplete = p.batchesDone >= p.batches || (p.toScrape > 0 && totalDone >= p.toScrape);
          if (isComplete) {
            const duration = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;
            await CrawlJob.updateOne(
              { jobId: job.jobId },
              { status: 'completed', completedAt: new Date(), durationMs: duration }
            );
            bus.publish('job:completed', {
              jobId: job.jobId,
              cityName: job.input?.cityName || job.input?.regionName,
              status: 'completed',
              durationMs: duration,
            });
            logger.info(`🧹 Reconciled job as completed (all batches finished before restart): ${job.jobId}`);
            resumed++;
            continue;
          }
        }

        // Truly orphaned: discovery job not active, and no batch children pending/unaccounted for.
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

    if (resumed > 0) {
      logger.info(`🧹 Reconciled ${resumed} job(s) as completed (finished mid-restart).`);
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
