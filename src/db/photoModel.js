'use strict';
const mongoose = require('mongoose');

const PhotoSchema = new mongoose.Schema({
  opgId:        { type: String, index: true, trim: true, match: /^PHT-[A-Z]+-[0-9A-Z]{11,14}$/ },
  spaceId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Space', index: true },
  spaceOpgId:   { type: String, index: true, trim: true },
  assetOpgId:   { type: String, default: null },         // cross-DB ref to opg-media AST-*
  publicUrl:    { type: String, sparse: true },          // denorm rendered url (ours after download)
  originalUrl:  String,                                  // source URL (Google CDN)
  thumbnailUrl: String,
  // Source classification
  sourceType: {
    type: String,
    enum: ['user', 'owner', 'cover', 'video_thumb', 'streetview', 'review_photo', 'google'],
    default: 'google',
    index: true,
  },
  // Download tracking — false = URL captured only, true = owned by opg-media
  downloaded:   { type: Boolean, default: false },
  type:         { type: String, enum: ['cover', 'interior', 'exterior', 'equipment', 'general', 'photo', 'video', 'thumbnail'], default: 'general', index: true },
  width:        Number,
  height:       Number,
  order:        { type: Number, index: true },
  isCover:      { type: Boolean, default: false },
  createdVia:   { type: String, default: 'crawler' },
  deletedAt:    { type: Date, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  collection: 'space_photos',
  autoIndex: false,
});

// ── Indexes ────────────────────────────────────────────────────────────────────
PhotoSchema.index({ publicUrl: 1 }, { unique: true, sparse: true });
PhotoSchema.index({ originalUrl: 1, spaceId: 1 }, { sparse: true, name: 'photos_originalUrl_spaceId' });
PhotoSchema.index({ spaceId: 1, type: 1 });
PhotoSchema.index({ spaceId: 1, sourceType: 1 });
PhotoSchema.index({ downloaded: 1, spaceId: 1 });
PhotoSchema.index({ spaceId: 1, createdAt: -1 });
PhotoSchema.index({ spaceOpgId: 1, order: 1 }, { name: 'idx_space_order' });

module.exports = mongoose.model('Photo', PhotoSchema);
