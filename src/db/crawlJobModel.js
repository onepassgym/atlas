'use strict';
const mongoose = require('mongoose');

const CrawlJobSchema = new mongoose.Schema({
  jobId:  { type: String, required: true, unique: true },
  type:   { type: String, enum: ['city', 'gym_name', 'retry', 'chain', 'enrichment'], default: 'city' },

  input: {
    cityName:   String,
    gymName:    String,
    categories: [String],
    chainSlug:  String,        // e.g. "anytime-fitness"
    chainName:  String,        // e.g. "Anytime Fitness"
    countries:  [String],      // optional filter: ["US","IN","AU"]
  },

  status: {
    type:    String,
    enum:    ['queued','running','completed','failed','partial','cancelled'],
    default: 'queued',
  },

  progress: {
    total:         { type: Number, default: 0 },
    toScrape:      { type: Number, default: 0 },
    scraped:       { type: Number, default: 0 },
    failed:        { type: Number, default: 0 },
    skipped:       { type: Number, default: 0 },
    newSpaces:     { type: Number, default: 0 },
    updatedSpaces: { type: Number, default: 0 },
    blockedCount:  { type: Number, default: 0 },
  },

  // Per-category discovery yield (Phase 2: crawl gap visibility)
  categoryYield: [{
    category: String,
    urlsFound: { type: Number, default: 0 },
    error: String,
    _id: false,
  }],

  queuedAt:    { type: Date, default: Date.now },
  startedAt:   Date,
  completedAt: Date,
  durationMs:  Number,

  spaceIds:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Space' }],
  opgId:      { type: String, index: true, trim: true },
  jobErrors:  [{ message: String, url: String, at: Date }],
  errorCount: { type: Number, default: 0 },

  bullJobId: String,

}, { timestamps: true, collection: 'gym_crawl_jobs' });

CrawlJobSchema.index({ status: 1 });
CrawlJobSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CrawlJob', CrawlJobSchema);
