'use strict';
/**
 * mediaWorker.js — Dedicated BullMQ worker for photo download + resize.
 *
 * Consumes jobs from the 'atlas-media' queue (enqueued by spaceProcessor.js).
 * Does NOT use Playwright — purely HTTP downloads + Sharp image processing.
 * Can safely run at high concurrency (8-10) since it is I/O bound, not CPU bound.
 *
 * Each job payload: { spaceId, slug, photoUrls }
 * On completion:    gym document's photos[], coverPhoto, totalPhotos, and
 *                   crawlMeta.mediaStatus are updated in MongoDB.
 */
require('dotenv').config();

const { Worker }             = require('bullmq');
const { connectDB }          = require('../db/connection');
const { downloadAllMedia }   = require('../media/downloader');
const Space                    = require('../db/spaceModel');
const Photo                  = require('../db/photoModel');
const SystemState            = require('../db/systemStateModel');
const cfg                    = require('../../config');
const logger                 = require('../utils/logger');

const connection = {
  host:     cfg.redis.host,
  port:     cfg.redis.port,
  password: cfg.redis.password || undefined,
};

// Media workers are I/O bound — run many in parallel
const MEDIA_CONCURRENCY = parseInt(process.env.MEDIA_WORKER_CONCURRENCY || '8', 10);

let isShuttingDown = false;

async function waitIfPaused() {
  let state = await SystemState.getGlobalState().catch(() => ({ mediaQueuePaused: false, globalPause: false }));
  while ((state.globalPause || state.mediaQueuePaused) && !isShuttingDown) {
    await new Promise(r => setTimeout(r, 5000));
    state = await SystemState.getGlobalState().catch(() => ({ mediaQueuePaused: false, globalPause: false }));
  }
}

// ── Job handler ───────────────────────────────────────────────────────────────

async function processMediaJob(job) {
  const { spaceId, slug, photoUrls } = job.data;

  // Wait indefinitely if the queue is paused or system is in standby
  await waitIfPaused();

  if (!photoUrls?.length) {
    logger.info(`[media] No photos to download for gym ${spaceId}`);
    return { downloaded: 0 };
  }

  logger.info(`[media] ⬇  Downloading ${photoUrls.length} photos for ${slug} (spaceId: ${spaceId})`);

  try {
    // Download + resize all photos (4 concurrent axios+sharp calls inside)
    const media = await downloadAllMedia(photoUrls, slug);

    const downloaded = media.filter(m => m?.localPath).length;
    const failed     = media.filter(m => !m?.localPath).length;

    if (!media.length) {
      logger.warn(`[media] All downloads failed for ${slug}`);
      await Space.findByIdAndUpdate(spaceId, {
        $set: { 'crawlMeta.mediaStatus': 'failed', updatedAt: new Date() }
      });
      return { downloaded: 0, failed: photoUrls.length };
    }

    // Batch-upsert photo records into gym_photos collection
    const now = new Date();
    const photoOps = media
      .filter(m => m?.publicUrl)
      .map(m => ({
        updateOne: {
          filter: { publicUrl: m.publicUrl },
          update: {
            $setOnInsert: {
              spaceId,
              originalUrl:  m.originalUrl,
              localPath:    m.localPath,
              publicUrl:    m.publicUrl,
              thumbnailUrl: m.thumbnailUrl,
              type:         m.type || 'photo',
              width:        m.width,
              height:       m.height,
              sizeBytes:    m.sizeBytes,
              appealScore:  m.appealScore || 0,
              brightness:   m.brightness,
              contrast:     m.contrast,
              tags:         m.tags || [],
              downloadedAt: m.downloadedAt || now,
              createdAt:    now,
            }
          },
          upsert: true,
        }
      }));

    if (photoOps.length) {
      await Photo.bulkWrite(photoOps, { ordered: false });
    }

    // Sort by visual appeal score descending, pick the highest as cover
    const validPhotos = media.filter(m => m?.localPath);
    validPhotos.sort((a, b) => (b.appealScore || 0) - (a.appealScore || 0));
    const coverPhoto = validPhotos[0] || null;

    // Calculate overall visual appeal score for the gym
    const visualAppealScore = validPhotos.length > 0 
      ? Math.round(validPhotos.reduce((sum, p) => sum + (p.appealScore || 0), 0) / validPhotos.length) 
      : 0;

    await Space.findByIdAndUpdate(spaceId, {
      $set: {
        photos:      media,
        coverPhoto,
        visualAppealScore,
        totalPhotos: media.length,
        'crawlMeta.mediaStatus': failed > 0 ? 'partial' : 'completed',
        updatedAt:   now,
      }
    });

    logger.info(`[media] ✅ ${slug}: ${downloaded} ok, ${failed} failed`);
    return { downloaded, failed };

  } catch (err) {
    logger.error(`[media] ❌ Error for ${slug}: ${err.message}`);
    // Mark as failed so enrichment job can retry
    try {
      await Space.findByIdAndUpdate(spaceId, {
        $set: { 'crawlMeta.mediaStatus': 'failed', updatedAt: new Date() }
      });
    } catch (_) {}
    throw err;
  }
}

// ── Worker startup ────────────────────────────────────────────────────────────

async function start() {
  await connectDB();

  const worker = new Worker('atlas-media', processMediaJob, {
    connection,
    concurrency: MEDIA_CONCURRENCY,
    lockDuration: 120_000, // 2 min — media jobs are fast
  });

  worker.on('completed', (job, result) => {
    logger.info(`[media] ✓ Job ${job.id} done: ${result?.downloaded ?? 0} photos downloaded`);
  });
  worker.on('failed', (job, err) => {
    logger.error(`[media] ✗ Job ${job?.id} failed: ${err.message}`);
  });
  worker.on('error', (err) => {
    logger.error(`[media] Worker error: ${err.message}`);
  });

  logger.info(`\n📷 Atlas Media Worker started [concurrency: ${MEDIA_CONCURRENCY}]`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    isShuttingDown = true;
    logger.info(`\n⏳ Media worker received ${signal} — draining...`);
    try { await worker.close(); } catch (_) {}
    logger.info('👋 Media worker shut down.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => {
  console.error('Media worker startup error:', err);
  process.exit(1);
});
