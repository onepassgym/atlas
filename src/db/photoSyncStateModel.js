'use strict';
const mongoose = require('mongoose');

/**
 * Tracks the rolling cursor for the space photo sync rotation.
 * One singleton document keyed by 'photo_sync'.
 */
const PhotoSyncStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'photo_sync' },

  // Rotation cursor — _id of the last space that was fully processed in this cycle.
  // On the next run we query spaces whose _id > lastProcessedSpaceId (sorted ASC).
  // When we reach the end of the collection we reset to null and start a new cycle.
  lastProcessedSpaceId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // How many spaces have been processed in the current cycle
  currentCycleProcessed: { type: Number, default: 0 },

  // Total spaces in DB at the start of the latest cycle (informational)
  currentCycleTotalSpaces: { type: Number, default: 0 },

  // Cycle counter — increments every time the full rotation completes
  completedCycles: { type: Number, default: 0 },

  // Running stats for the CURRENT run
  lastRunAt:        { type: Date, default: null },
  lastRunStatus:    { type: String, enum: ['idle', 'running', 'done', 'error'], default: 'idle' },
  lastRunProcessed: { type: Number, default: 0 },
  lastRunUpserted:  { type: Number, default: 0 },
  lastRunSkipped:   { type: Number, default: 0 },
  lastRunError:     { type: String, default: null },

  // Lock: prevents two concurrent runs from stepping on each other.
  // Set to a timestamp when a job starts; cleared when done.
  // If the lock is older than 2 hours, it is considered stale and auto-released.
  lockedAt:  { type: Date, default: null },
  lockedBy:  { type: String, default: null }, // 'cron' | 'manual'
}, {
  timestamps: true,
  collection: 'photo_sync_state',
  autoIndex: false,
});

PhotoSyncStateSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'photo_sync' });
  if (!doc) doc = await this.create({ key: 'photo_sync' });
  return doc;
};

/** Returns true if a lock is held AND is not stale (< 2 h old). */
PhotoSyncStateSchema.methods.isLocked = function () {
  if (!this.lockedAt) return false;
  const twoHours = 2 * 60 * 60 * 1000;
  return (Date.now() - this.lockedAt.getTime()) < twoHours;
};

module.exports = mongoose.model('PhotoSyncState', PhotoSyncStateSchema);
