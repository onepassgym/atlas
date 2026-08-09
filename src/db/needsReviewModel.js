'use strict';
const mongoose = require('mongoose');

const NeedsReviewSchema = new mongoose.Schema(
  {
    // NRV-{ANIMAL}-{base32} — minted via makeOpgId('needsReview')
    opgId: { type: String, unique: true, sparse: true },

    type: {
      type: String,
      required: true,
      enum: ['dedup_ambiguous', 'category_unmapped', 'geo_invalid', 'required_field_missing'],
    },

    // ── dedup_ambiguous ───────────────────────────────────────────────────────
    candidate: {
      rawSourceId: mongoose.Schema.Types.ObjectId,
      name:        String,
      phone:       String,
      location:    { type: [Number] }, // [lng, lat]
      placeId:     String,
      sourceId:    String,
      source:      String,
    },
    existingEntityOpgId: String,
    matchTier:           Number,
    confidence:          Number,

    // ── category_unmapped ─────────────────────────────────────────────────────
    spaceOpgId:    String,
    rawType:       String,      // the Maps/OSM type that had no taxonomy mapping
    suggestedSlug: String,      // null until a human resolves

    // ── geo_invalid ───────────────────────────────────────────────────────────
    detectedCoords:  [Number],  // [lng, lat] out of expected bounds
    expectedBounds:  {
      minLat: Number, maxLat: Number,
      minLng: Number, maxLng: Number,
    },

    // ── required_field_missing ────────────────────────────────────────────────
    missingFields: [String],

    // ── Resolution ───────────────────────────────────────────────────────────
    status:     { type: String, enum: ['pending', 'resolved', 'dismissed'], default: 'pending' },
    resolvedBy: String,
    resolvedAt: Date,
    resolution: mongoose.Schema.Types.Mixed, // { action: 'merge'|'new'|'skip', targetOpgId? }

    createdVia: { type: String, default: 'atlas-crawler' },
    deletedAt:  { type: Date, default: null },
  },
  {
    collection: 'needs_review',
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    autoIndex:  false,
  }
);

module.exports = mongoose.model('NeedsReview', NeedsReviewSchema);
