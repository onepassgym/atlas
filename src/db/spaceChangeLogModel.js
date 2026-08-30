'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

// ── Schema ────────────────────────────────────────────────────────────────────

const SpaceChangeLogSchema = new mongoose.Schema(
  {
    spaceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true },
    // Denormalized public identifier — populated at write time from parent space.
    // Never used for $lookup or joins; spaceId (ObjectId) is always the join key.
    opgId:    { type: String, index: true, uppercase: true, trim: true },
    field:    { type: String, required: true },
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
    changedAt:{ type: Date, default: () => new Date() },
    source:   { type: String, default: 'crawler' },
  },
  {
    // No auto-timestamps — changedAt is explicit above
    timestamps: false,
    collection: cfg.collections.spaceChangeLogs,
    autoIndex: false,
  }
);

// ── Indexes (also created imperatively in ensureIndexes.js) ───────────────────
SpaceChangeLogSchema.index({ spaceId: 1 });
SpaceChangeLogSchema.index({ changedAt: -1 });

module.exports = mongoose.model('SpaceChangeLog', SpaceChangeLogSchema);
