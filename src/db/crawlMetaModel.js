'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const CrawlMetaSchema = new mongoose.Schema({
  gymId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
  // Denormalized public identifier — populated at write time from parent gym.
  // Never used for $lookup or joins; gymId (ObjectId) is always the join key.
  opgId:            { type: String, index: true, uppercase: true, trim: true },
  firstCrawledAt:   Date,
  lastCrawledAt:    Date,
  crawlStatus:      { type: String, enum: ['pending','in_progress','completed','failed','partial'], default: 'pending' },
  crawlVersion:     { type: Number, default: 1 },
  crawlError:       String,
  missingFields:    [String],
  dataCompleteness: { type: Number, default: 0 },
  sourceUrl:        String,
  jobId:            String,
}, { timestamps: true, collection: cfg.collections.spaceCrawlMeta, autoIndex: false });

CrawlMetaSchema.index({ gymId: 1 }, { unique: true });
CrawlMetaSchema.index({ jobId: 1 });

module.exports = mongoose.model('CrawlMeta', CrawlMetaSchema);
