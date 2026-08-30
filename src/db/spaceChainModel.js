'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const SpaceChainSchema = new mongoose.Schema({
  slug:           { type: String, required: true, unique: true },   // "anytime-fitness"
  name:           { type: String, required: true },                  // "Anytime Fitness"
  aliases:        [String],                                          // ["Anytime", "AF"]

  // Chain metadata
  headquarters:    String,                                           // "Woodbury, Minnesota, USA"
  foundedYear:     Number,
  website:         String,
  logoUrl:         String,

  // Store locator config (for automated crawling)
  storeLocator: {
    type:            { type: String, enum: ['api', 'html', 'none'], default: 'none' },
    url:             String,
    method:          { type: String, default: 'GET' },
    headers:         mongoose.Schema.Types.Mixed,
    bodyTemplate:    mongoose.Schema.Types.Mixed,
    responseParser:  String,           // key into chainLocators registry
  },

  // Stats (auto-updated after each crawl)
  totalLocations:   { type: Number, default: 0 },
  countriesPresent: [String],

  // Crawl state
  lastCrawledAt:    Date,
  crawlFrequency:   { type: String, enum: ['weekly', 'biweekly', 'monthly', 'quarterly'], default: 'monthly' },
  isActive:         { type: Boolean, default: true },

}, { timestamps: true, collection: cfg.collections.spaceChains });

SpaceChainSchema.index({ name: 1 });
SpaceChainSchema.index({ isActive: 1 });

module.exports = mongoose.model('SpaceChain', SpaceChainSchema);
