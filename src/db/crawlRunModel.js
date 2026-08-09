'use strict';
const mongoose = require('mongoose');

const RunErrorSchema = new mongoose.Schema(
  {
    type:      String,
    message:   String,
    url:       String,
    timestamp: { type: Date, default: Date.now },
    retryable: { type: Boolean, default: true },
  },
  { _id: false }
);

const CrawlRunSchema = new mongoose.Schema(
  {
    runId:        { type: String, required: true, unique: true }, // UUID
    crawlJobId:   { type: mongoose.Schema.Types.ObjectId, ref: 'CrawlJob' },
    source:       { type: String, enum: ['google_maps', 'justdial', 'osm', 'yelp', 'duckduckgo', 'multi'] },
    query:        String,
    locationOpgId: String,
    categorySlug:  String,
    startedAt:    { type: Date, default: Date.now },
    finishedAt:   Date,
    durationMs:   Number,

    recordsFound:       { type: Number, default: 0 }, // returned by source
    recordsRaw:         { type: Number, default: 0 }, // written to raw_sources
    recordsNew:         { type: Number, default: 0 }, // new entities created
    recordsUpdated:     { type: Number, default: 0 }, // existing entities updated
    recordsDropped:     { type: Number, default: 0 }, // failed validation
    recordsNeedsReview: { type: Number, default: 0 }, // routed to needs_review

    runErrors: { type: [RunErrorSchema], default: [] },

    httpStats: {
      s429Count:          { type: Number, default: 0 },
      s403Count:          { type: Number, default: 0 },
      s5xxCount:          { type: Number, default: 0 },
      timeouts:           { type: Number, default: 0 },
      blockDetectedCount: { type: Number, default: 0 }, // isBlocked() fired
      sessionRotations:   { type: Number, default: 0 }, // fresh browser launches mid-run
      emptyPageCount:     { type: Number, default: 0 }, // silent blocks
    },

    createdVia: { type: String, default: 'atlas-crawler' },
  },
  {
    collection: 'crawl_runs',
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    autoIndex:  false,
  }
);

module.exports = mongoose.model('CrawlRun', CrawlRunSchema);
