'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const PhotoSchema = new mongoose.Schema({
  gymId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', index: true },
  // Denormalized public identifier — populated at write time from parent gym.
  // Never used for $lookup or joins; gymId (ObjectId) is always the join key.
  opgId:        { type: String, index: true, uppercase: true, trim: true },
  originalUrl:  String,
  localPath:    String,
  publicUrl:    { type: String, sparse: true },
  thumbnailUrl: String,
  // Source classification — enrichment adds more granular types
  sourceType: {
    type: String,
    enum: ['user', 'owner', 'cover', 'video_thumb', 'streetview', 'review_photo'],
    default: 'user',
    index: true,
  },
  // Download tracking — false = URL captured only, true = file exists on disk
  downloaded:   { type: Boolean, default: false },
  capturedAt:   { type: Date, default: Date.now },
  type:         { type: String, enum: ['photo', 'video', 'thumbnail', 'cover'], default: 'photo', index: true },
  caption:      String,
  filename:     String,           // basename of stored file
  folder:       String,           // relative sub-folder e.g. "photos/gym-slug"
  width:        Number,
  height:       Number,
  sizeBytes:    Number,
  mimeType:     String,
  appealScore:  { type: Number, default: 0 },
  brightness:   Number,
  contrast:     Number,
  tags:         [{ type: String, index: true }],
  isCover:      { type: Boolean, default: false },
  isOrphaned:   { type: Boolean, default: false }, // file on disk but no gym match
  downloadedAt: Date,
  downloadError: String,
  // Sync tracking
  fsVerifiedAt: Date,             // last time file existence was confirmed on disk
  fsExists:     { type: Boolean, default: true },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  collection: cfg.collections.spacePhotos,
  autoIndex: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

PhotoSchema.virtual('proxyUrl').get(function() {
  return `/api/media/${this._id}/view`;
});

// ── Compound indexes for scalable queries ──────────────────────────────────────
PhotoSchema.index({ publicUrl: 1 }, { unique: true, sparse: true });
PhotoSchema.index({ gymId: 1, type: 1 });
PhotoSchema.index({ gymId: 1, sourceType: 1 });               // Task 7 index
PhotoSchema.index({ downloaded: 1, gymId: 1 });               // Task 7 index — future download queue
PhotoSchema.index({ gymId: 1, createdAt: -1 });
PhotoSchema.index({ type: 1, createdAt: -1 });
PhotoSchema.index({ createdAt: -1 });
PhotoSchema.index({ sizeBytes: -1 });
PhotoSchema.index({ appealScore: -1 });
PhotoSchema.index({ folder: 1 });
PhotoSchema.index({ fsExists: 1 });
PhotoSchema.index({ tags: 1 });
// Text search index
PhotoSchema.index({ caption: 'text', filename: 'text', folder: 'text' });

module.exports = mongoose.model('Photo', PhotoSchema);
