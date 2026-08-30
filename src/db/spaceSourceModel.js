'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const SpaceSourceSchema = new mongoose.Schema(
  {
    spaceId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true, index: true },
    // Denormalized public identifier for external use; joins still use spaceId.
    opgId:              { type: String, index: true, uppercase: true, trim: true },
    provider:           { type: String, required: true, default: 'google_maps', index: true },
    providerPlaceId:    { type: String },
    providerUrl:        { type: String },
    providerUrlCanonical:{ type: String },
    providerUrlHash:    { type: String },
    sourcePayloadHash:  { type: String },
    firstSeenAt:        { type: Date, default: Date.now },
    lastSeenAt:         { type: Date, default: Date.now },
    lastCrawledAt:      { type: Date, default: Date.now },
    crawlVersion:       { type: Number, default: 1 },
    status:             { type: String, enum: ['completed', 'partial', 'failed'], default: 'completed' },
    lastJobId:          { type: String },
    lastError:          { type: String },
    meta:               { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: cfg.collections.spaceSources,
    autoIndex: false,
  }
);

SpaceSourceSchema.index({ spaceId: 1, provider: 1 }, { unique: true, name: 'spaceSource_space_provider_unique' });
SpaceSourceSchema.index({ provider: 1, providerPlaceId: 1 }, {
  unique: true,
  sparse: true,
  name: 'spaceSource_provider_placeId_unique',
});
SpaceSourceSchema.index({ provider: 1, providerUrlHash: 1 }, {
  unique: true,
  sparse: true,
  name: 'spaceSource_provider_urlHash_unique',
});
SpaceSourceSchema.index({ provider: 1, lastCrawledAt: -1 }, { name: 'spaceSource_provider_lastCrawledAt' });

module.exports = mongoose.model('SpaceSource', SpaceSourceSchema);