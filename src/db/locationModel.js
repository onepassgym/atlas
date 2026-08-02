'use strict';
const mongoose = require('mongoose');

const GeoPointSchema = new mongoose.Schema({
  type:        { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true },
}, { _id: false });

const LocationSchema = new mongoose.Schema({
  opgId:        { type: String, unique: true, sparse: true, trim: true, match: /^LOC-[A-Z]+-[0-9A-Z]{11,14}$/ },
  type:         { type: String, enum: ['country', 'state', 'city', 'area'], required: true, index: true },
  parentOpgId:  { type: String, default: null, index: true },
  slug:         { type: String, unique: true, required: true },
  name:         { type: String, required: true },
  displayName:  String,
  state:        { type: String, index: true },
  country:      { type: String, default: 'IN' },
  center:       { type: GeoPointSchema },
  bounds:       mongoose.Schema.Types.Mixed,
  aliases:      [String],
  pincodes:     [String],
  spaceCount:   { type: Number, default: 0 },
  isServiceable:{ type: Boolean, default: false, index: true },
  seo:          {
    metaTitle:  String,
    metaDesc:   String,
    keywords:   [String],
    ogImage:    String,
    canonical:  String,
  },
  createdVia:   { type: String, default: 'crawler' },
  isActive:     { type: Boolean, default: true },
  deletedAt:    { type: Date, default: null },
}, { timestamps: true, collection: 'locations', autoIndex: false });

// Indexes
LocationSchema.index({ opgId: 1 }, { unique: true, sparse: true });
LocationSchema.index({ center: '2dsphere' }, { sparse: true });
LocationSchema.index({ type: 1, isServiceable: 1 }, { name: 'idx_loc_type_serviceable' });
LocationSchema.index({ parentOpgId: 1, type: 1 },   { name: 'idx_loc_parent' });
LocationSchema.index({ aliases: 1 });

module.exports = mongoose.model('Location', LocationSchema);
