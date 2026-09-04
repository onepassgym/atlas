'use strict';
const mongoose = require('mongoose');

const PageDataSchema = new mongoose.Schema({
  // SEO Meta
  seoTitle: { type: String, trim: true },
  metaDescription: { type: String, trim: true },
  keywords: [{ type: String, trim: true }],

  // Social / Open Graph
  ogImage: { type: String, trim: true },
  ogTitle: { type: String, trim: true },
  twitterCardType: { type: String, trim: true },

  // Redirect Management
  redirectTo: { type: String, trim: true },
  statusCode: { type: Number, default: 200 },

  // Content Overrides
  displayTitle: { type: String, trim: true },
  shortPitch: { type: String, trim: true },
  marketingBadge: { type: String, trim: true },

  // Tracking / Campaign
  campaignSource: { type: String, trim: true },
  affiliateLinkOverride: { type: String, trim: true },
}, { _id: false });

const PageSlugSchema = new mongoose.Schema({
  slug: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true,
    trim: true,
    lowercase: true 
  },
  spaceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Space', 
    required: true,
    index: true
  },
  opgId: { 
    type: String,
    index: true
  },
  pageData: {
    type: PageDataSchema,
    default: () => ({})
  },
  isActive: { 
    type: Boolean, 
    default: true 
  }
}, { 
  timestamps: true, 
  collection: 'page_slugs' 
});

module.exports = mongoose.model('PageSlug', PageSlugSchema);
