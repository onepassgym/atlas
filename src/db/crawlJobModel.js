'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const CrawlJobSchema = new mongoose.Schema({
  jobId:  { type: String, required: true, unique: true },
  type:   { type: String, enum: ['city', 'grid', 'gym_name', 'retry', 'chain', 'enrichment'], default: 'city' },

  input: {
    cityName:   String,
    regionName: String,        // added for grid
    lat:        Number,        // added for grid
    lng:        Number,        // added for grid
    zoom:       Number,        // added for grid
    spaceName:  String,
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
    total:       { type: Number, default: 0 },
    scraped:     { type: Number, default: 0 },
    failed:      { type: Number, default: 0 },
    skipped:     { type: Number, default: 0 },
    newGyms:     { type: Number, default: 0 },
    updatedGyms: { type: Number, default: 0 },
  },

  queuedAt:    { type: Date, default: Date.now },
  startedAt:   Date,
  completedAt: Date,
  durationMs:  Number,

  gymIds:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gym' }],
  // Denormalized public identifier — set when job processes a single gym target.
  // Never used for $lookup or joins; gymIds (ObjectId array) is always the join key.
  opgId:      { type: String, index: true, uppercase: true, trim: true },
  jobErrors:  [{ message: String, url: String, at: Date }],  // renamed from 'errors' (reserved)
  errorCount: { type: Number, default: 0 },

  queueJobId: String,

}, { timestamps: true, collection: cfg.collections.spaceCrawlJobs });

CrawlJobSchema.index({ status: 1 });
CrawlJobSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CrawlJob', CrawlJobSchema);
