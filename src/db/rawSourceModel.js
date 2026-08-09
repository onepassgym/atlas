'use strict';
const mongoose = require('mongoose');

const RawSourceSchema = new mongoose.Schema(
  {
    source:        { type: String, required: true, enum: ['google_maps', 'justdial', 'osm', 'yelp', 'official_website', 'duckduckgo'] },
    sourceId:      { type: String, required: true }, // placeId, JD listing ID, OSM node ID
    payload:       { type: mongoose.Schema.Types.Mixed, required: true }, // untransformed raw response
    version:       { type: Number, default: 1 },     // increments per re-fetch of same sourceId
    crawlRunId:    { type: mongoose.Schema.Types.ObjectId, ref: 'CrawlRun' },
    locationOpgId: { type: String },
    fetchedAt:     { type: Date, default: Date.now },
    supersededAt:  { type: Date, default: null },     // null = current version
    isArchived:    { type: Boolean, default: false }, // true when version > 5
    createdVia:    { type: String, default: 'atlas-crawler' },
  },
  {
    collection: 'raw_sources',
    timestamps: false,
    autoIndex:  false,
  }
);

module.exports = mongoose.model('RawSource', RawSourceSchema);
