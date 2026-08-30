'use strict';
/**
 * photoSyncService.js
 *
 * Background worker that syncs space photos into the space_photos collection.
 * Implements a weekly rotation: every day at 4 AM it processes a batch of spaces,
 * resuming from where the previous run stopped. When all spaces have been processed
 * once, a new cycle begins.
 *
 * Concurrency safety:
 *   - Uses a DB-level lock (PhotoSyncState.lockedAt) to prevent concurrent runs.
 *   - Stale locks (> 2 hours old) are automatically released.
 *
 * State machine:
 *   idle → running → done | error → idle (next run)
 *   When lastProcessedSpaceId reaches the end of collection → reset cursor → new cycle
 */

const mongoose = require('mongoose');
const Photo = require('../db/photoModel');
const Space   = require('../db/spaceModel');
const PhotoSyncState = require('../db/photoSyncStateModel');
const cfg    = require('../../config');
const logger = require('../utils/logger');
const { buildOp, collectPhotos } = require('./photoMigrationHelpers');

// ── Tuning ────────────────────────────────────────────────────────────────────
const SPACES_PER_RUN = 500;   // spaces to process per daily run (tune for your VPS)
const BATCH_SIZE   = 200;   // photo ops per bulkWrite flush
const RUN_TAG = `photo-sync-${process.pid}`; // unique tag for this process instance

// ── Core sync runner ──────────────────────────────────────────────────────────

/**
 * Run one sync batch. Processes up to SPACES_PER_RUN spaces.
 * Safe to call from cron or a manual trigger.
 *
 * @param {string} triggeredBy  'cron' | 'manual'
 * @returns {Promise<object>}   summary of the run
 */
async function runPhotoSync(triggeredBy = 'cron') {
  // ── Acquire lock ──────────────────────────────────────────────────────────
  const state = await PhotoSyncState.getSingleton();

  if (state.isLocked()) {
    logger.warn(`[photo-sync] Already running (locked by ${state.lockedBy} at ${state.lockedAt}). Skipping.`);
    return { skipped: true, reason: 'locked' };
  }

  // Lock
  state.lockedAt      = new Date();
  state.lockedBy      = triggeredBy;
  state.lastRunAt     = new Date();
  state.lastRunStatus = 'running';
  state.lastRunError  = null;
  await state.save();

  logger.info(`[photo-sync] Starting sync (trigger: ${triggeredBy}, cursor: ${state.lastProcessedSpaceId || 'start'}, cycle: ${state.completedCycles + 1})`);

  let processed = 0, upserted = 0, skipped = 0;

  try {
    // ── Count total spaces for progress tracking ────────────────────────────
    const totalSpaces = await Space.countDocuments();

    // ── Build query: pick up after cursor ────────────────────────────────
    const filter = {
      $or: [
        { 'coverPhoto.publicUrl': { $exists: true, $ne: null } },
        { rawPhotos: { $exists: true, $type: 'array', $ne: [] } },
      ],
    };
    if (state.lastProcessedSpaceId) {
      filter._id = { $gt: state.lastProcessedSpaceId };
    }

    const spaces = await Space.find(filter)
      .select('_id slug coverPhoto rawPhotos')
      .sort({ _id: 1 })
      .limit(SPACES_PER_RUN)
      .lean();

    if (spaces.length === 0) {
      // ── Cycle complete — reset cursor for next cycle ──────────────────
      const prevCycle = state.completedCycles;
      state.completedCycles++;
      state.currentCycleProcessed = 0;
      state.currentCycleTotalSpaces = totalSpaces;
      state.lastProcessedSpaceId = null;
      logger.info(`[photo-sync] ✅ Cycle ${prevCycle + 1} complete. Resetting cursor for cycle ${state.completedCycles + 1}.`);
    } else {
      // ── Process batch ─────────────────────────────────────────────────
      let ops = [];

      async function flush() {
        if (!ops.length) return;
        try {
          const result = await Photo.bulkWrite(ops, { ordered: false });
          upserted += result.upsertedCount + result.modifiedCount;
        } catch (bwe) {
          upserted += bwe.result?.result?.nUpserted || 0;
          logger.warn(`[photo-sync] bulkWrite partial (${bwe.code}): ${String(bwe.message).slice(0, 150)}`);
        }
        ops = [];
      }

      for (const space of spaces) {
        const photoMap = collectPhotos(space);
        if (photoMap.size === 0) { skipped++; continue; }

        for (const { p, isCover } of photoMap.values()) {
          ops.push(buildOp(space._id, space.slug, p, isCover));
          if (ops.length >= BATCH_SIZE) {
            await flush();
            if (upserted % 2000 === 0 && upserted > 0)
              logger.info(`[photo-sync] ${upserted} photos upserted so far...`);
          }
        }
        processed++;
      }

      await flush();

      // Advance cursor to the last space's _id
      state.lastProcessedSpaceId = spaces[spaces.length - 1]._id;
      state.currentCycleProcessed = (state.currentCycleProcessed || 0) + processed;
      state.currentCycleTotalSpaces = totalSpaces;
    }

    // ── Update state ──────────────────────────────────────────────────────
    state.lastRunStatus    = 'done';
    state.lastRunProcessed = processed;
    state.lastRunUpserted  = upserted;
    state.lastRunSkipped   = skipped;
    state.lockedAt         = null;
    state.lockedBy         = null;
    await state.save();

    logger.info(`[photo-sync] ✅ Done: ${processed} spaces, ${upserted} upserted, ${skipped} skipped`);
    return { processed, upserted, skipped, completedCycles: state.completedCycles };

  } catch (e) {
    // ── Release lock on failure ───────────────────────────────────────────
    try {
      state.lastRunStatus = 'error';
      state.lastRunError  = String(e.message || e).slice(0, 500);
      state.lockedAt      = null;
      state.lockedBy      = null;
      await state.save();
    } catch (_) {}
    logger.error(`[photo-sync] Error: ${e.stack || e}`);
    throw e;
  }
}

/**
 * Get current sync state (for the API/dashboard).
 */
async function getSyncStatus() {
  const state = await PhotoSyncState.getSingleton();
  const totalSpaces = state.currentCycleTotalSpaces || 0;
  const cycleProgress = totalSpaces > 0
    ? Math.min(100, Math.round((state.currentCycleProcessed / totalSpaces) * 100))
    : 0;

  return {
    status:               state.lastRunStatus,
    isLocked:             state.isLocked(),
    lockedBy:             state.lockedBy,
    lastRunAt:            state.lastRunAt,
    lastRunProcessed:     state.lastRunProcessed,
    lastRunUpserted:      state.lastRunUpserted,
    lastRunSkipped:       state.lastRunSkipped,
    lastRunError:         state.lastRunError,
    completedCycles:      state.completedCycles,
    currentCycleProgress: cycleProgress,
    currentCycleProcessed: state.currentCycleProcessed,
    currentCycleTotalSpaces: state.currentCycleTotalSpaces,
    cursorAt:             state.lastProcessedSpaceId,
  };
}

module.exports = { runPhotoSync, getSyncStatus };
