'use strict';
const mongoose = require('mongoose');

const SpaceChainSchema = new mongoose.Schema({
  opgId:          { type: String, unique: true, sparse: true, trim: true, match: /^CHN-[A-Z]+-[0-9A-Z]{11,14}$/ },
  slug:           { type: String, required: true, unique: true },
  name:           { type: String, required: true },
  description:    String,
  aliases:        [String],

  // Media
  logoAssetOpgId: String,              // cross-DB ref to opg-media
  logoUrl:        String,              // denorm
  websiteUrl:     String,

  // Stats (cron-reconciled)
  totalBranches:  { type: Number, default: 0 },
  cityOpgIds:     [String],            // ref locations.opgId[]

  // Store locator config (for automated crawling)
  storeLocator: {
    type:            { type: String, enum: ['api', 'html', 'none'], default: 'none' },
    url:             String,
    method:          { type: String, default: 'GET' },
    headers:         mongoose.Schema.Types.Mixed,
    bodyTemplate:    mongoose.Schema.Types.Mixed,
    responseParser:  String,
  },

  // Crawl state
  lastCrawledAt:    Date,
  crawlFrequency:   { type: String, enum: ['weekly', 'biweekly', 'monthly', 'quarterly'], default: 'monthly' },

  isActive:       { type: Boolean, default: true },
  createdVia:     { type: String, default: 'crawler' },
  deletedAt:      { type: Date, default: null },
}, { timestamps: true, collection: 'space_chains' });

SpaceChainSchema.index({ opgId: 1 }, { unique: true, sparse: true });
SpaceChainSchema.index({ name: 1 });
SpaceChainSchema.index({ isActive: 1 });

module.exports = mongoose.model('SpaceChain', SpaceChainSchema);
