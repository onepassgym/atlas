'use strict';
const mongoose = require('mongoose');

const CrawlSeedSchema = new mongoose.Schema(
  {
    locationOpgId: { type: String, index: true },   // null until location doc exists
    cityName:      { type: String, required: true }, // denorm display
    categorySlugs: { type: [String], default: [] },  // from taxonomy.json

    priority:  { type: Number, default: 5, min: 1, max: 10 }, // 1 = highest priority
    frequency: { type: String, enum: ['hot', 'active', 'stale', 'dead'], default: 'active' },
    isEnabled: { type: Boolean, default: true, index: true },

    lastSeedAt:  Date,
    nextSeedAt:  { type: Date, index: true },

    consecutiveZeroRuns:    { type: Number, default: 0 },  // alerts at >= 3
    consecutiveGoogleBlocks:{ type: Number, default: 0 },  // downgrade at >= 3
    historicalAvgYield:     { type: Number, default: 0 },  // rolling 4-run avg
    googleMapsSkippedAt:    Date,
    lastGoodGoogleRunAt:    Date,

    createdVia: { type: String, default: 'atlas-crawler' },
    deletedAt:  { type: Date, default: null },
  },
  {
    collection: 'crawl_seeds',
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    autoIndex:  false,
  }
);

module.exports = mongoose.model('CrawlSeed', CrawlSeedSchema);
