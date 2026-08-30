'use strict';
const mongoose = require('mongoose');

const EnrichmentLogSchema = new mongoose.Schema(
  {
    spaceId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Space', 
      required: true 
    },
    spaceName: String, // Denormalized for quick list view
    status: { 
      type: String, 
      enum: ['success', 'failed', 'timeout', 'skipped'], 
      required: true 
    },
    durationMs: Number,
    error: String,
    fieldsUpdated: [String],
    photosAdded: { type: Number, default: 0 },
    reviewsAdded: { type: Number, default: 0 },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
  },
  { 
    timestamps: false, 
    collection: 'enrichment_logs' 
  }
);

EnrichmentLogSchema.index({ spaceId: 1 });
EnrichmentLogSchema.index({ startedAt: -1 });
EnrichmentLogSchema.index({ status: 1 });

module.exports = mongoose.model('EnrichmentLog', EnrichmentLogSchema);
