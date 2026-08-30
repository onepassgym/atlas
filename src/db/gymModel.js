'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

// Register related models for population
require('./categoryModel');
require('./amenityModel');
require('./reviewModel');
require('./photoModel');
require('./crawlMetaModel');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const GeoPointSchema = new mongoose.Schema({
  type:        { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true }, // [lng, lat]
}, { _id: false });

const HoursSchema = new mongoose.Schema({
  day:      String,
  open:     String,
  close:    String,
  isOpen24: { type: Boolean, default: false },
  isClosed: { type: Boolean, default: false },
}, { _id: false });

const ContactSchema = new mongoose.Schema({
  phone:      String,
  phone2:     String,      // secondary phone if listed
  website:    String,
  email:      String,
  whatsapp:   String,      // WhatsApp number if shown
  instagram:  String,      // full URL
  facebook:   String,      // full URL
  youtube:    String,      // full URL
  bookingUrl: String,      // "Book" / "Reserve" CTA link
  menuUrl:    String,      // class schedule PDF or menu link
}, { _id: false });

// (Legacy Schema omitted array embedded objects like reviews/photos to save space - they are now separate models)

// ── Main Schema ───────────────────────────────────────────────────────────────

const GymSchema = new mongoose.Schema({
  // Public canonical identifier — OPG-KEYWORD-XXXX
  // Never regenerated after first assignment. Never used in $lookup/$match.
  opgId: {
    type:      String,
    unique:    true,
    sparse:    true,
    index:     true,
    uppercase: true,
    trim:      true,
    match:     /^OPG-[A-Z]+-[A-Z2-9]{4}$/,
  },

  // Identity
  placeId:       { type: String, sparse: true },
  googleMapsUrl: String,
  name:          { type: String, required: true },
  slug:          String,
  aliases:       [String],

  // Category Normalized Links
  categoryId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  // Space-domain mirror fields for forward-compatible output
  primaryCategorySlug: String,
  categorySlugs: [String],
  amenitySlugs: [String],
  
  // Legacy / Unnormalized references
  category:    { type: String, default: 'fitness_venue' },
  categories:  [String],
  primaryType: String,
  types:       [String],

  // Location
  geoLocation: { type: GeoPointSchema },   // legacy 2dsphere field (kept for compat)
  location:    { type: GeoPointSchema },   // canonical GeoJSON field (2dsphere indexed)
  lat:         Number,
  lng:         Number,
  address:     String,
  addressParts: {
    street:     String,
    area:       String,
    city:       String,
    state:      String,
    country:    String,
    postalCode: String,
  },
  plusCode: String,

  // Contact
  contact: ContactSchema,

  // Ratings
  rating:       Number,
  totalReviews: { type: Number, default: 0 },
  ratingBreakdown: {
    fiveStar:  { type: Number, default: 0 },
    fourStar:  { type: Number, default: 0 },
    threeStar: { type: Number, default: 0 },
    twoStar:   { type: Number, default: 0 },
    oneStar:   { type: Number, default: 0 },
  },

  // Stats
  reviewsScraped: { type: Number, default: 0 },
  reviewSummary:  String,

  // Hours
  openingHours: [HoursSchema],
  isOpenNow:    Boolean,
  popularTimes: mongoose.Schema.Types.Mixed,

  // Media
  coverPhoto: {
    publicUrl:    String,
    thumbnailUrl: String,
    width:        Number,
    height:       Number
  },
  // All captured photo/video URLs — no downloads, deduped list
  rawPhotoUrls:  [String],
  totalPhotos:   { type: Number, default: 0 },

  // Pricing — raw text only, never parsed/normalised
  pricing: {
    rawText:    String,
    source:     { type: String, default: 'google_maps' },
    capturedAt: Date,
  },

  // Operational data — hours accuracy extension
  operationalData: {
    // Structured popular-times busyness per day
    popularTimesData: [{
      day:   String,
      hours: [{ hour: Number, busyness: Number }],
      _id:   false,
    }],
    // Holiday / special-date hour overrides
    specialHours: [{
      date:     String,  // e.g. "Dec 25"
      label:    String,  // e.g. "Christmas Day"
      open:     String,
      close:    String,
      isClosed: Boolean,
      _id:      false,
    }],
    lastHoursVerifiedAt: Date,
  },

  // Unmapped Google attribute sections — key = section label, value = array of items
  extraAttributes: {
    type: Map,
    of:   [String],
  },

  // Enrichment Summary
  enrichmentMeta: {
    lastAttempt:       Date,
    lastSuccess:       Date,
    status:           { type: String, enum: ['success', 'failed', 'never'], default: 'never' },
    consecutiveErrors: { type: Number, default: 0 },
    error:             String,
  },

  // Details
  description:    String,
  priceLevel:     String,
  amenityIds:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'Amenity' }],
  highlights:     [String],
  offerings:      [String],
  serviceOptions: [String],
  accessibility:  [String],

  // Status
  permanentlyClosed: { type: Boolean, default: false },
  temporarilyClosed: { type: Boolean, default: false },
  claimedByOwner:    { type: Boolean, default: false },

  // Data Intelligence (Phase 2)
  qualityScore:   { type: Number, default: 0 },
  scoreBreakdown: mongoose.Schema.Types.Mixed,
  visualAppealScore: { type: Number, default: 0 },
  sentimentScore: { type: Number, default: 0 },
  sentimentTags:  {
    positive: [String],
    negative: [String]
  },

  // Atlas platform fields
  atlas: {
    isListed:   { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    isPartner:  { type: Boolean, default: false },
    listedAt:   Date,
    partnerSince:Date,
    planIds:    [String],
  },

  // Chain Identity
  chainId:       { type: mongoose.Schema.Types.ObjectId, ref: 'GymChain', default: null },
  chainSlug:     { type: String, default: null },      // denormalized for fast queries
  chainName:     { type: String, default: null },      // denormalized for display
  isChainMember: { type: Boolean, default: false },

  // Job reference
  areaName:   String,
  crawlJobId: String,

  // Raw Crawled Arrays (Stored for diffing)
  rawPhotos:     [mongoose.Schema.Types.Mixed],
  rawAmenities:  mongoose.Schema.Types.Mixed,
  rawCrawlMeta:  mongoose.Schema.Types.Mixed,

  // Consolidated crawl mirror for application-side output and future migration.
  crawl: {
    jobId: String,
    status: String,
    version: Number,
    firstCrawledAt: Date,
    lastCrawledAt: Date,
    sourceUrl: String,
    dataCompleteness: Number,
  },

  // Data Pipeline
  parsed:    { type: Boolean, default: false },

}, { 
  timestamps: true, 
  collection: cfg.collections.spaces,
  autoIndex: false,
  toJSON: {
    virtuals: true,
    transform: (doc, ret) => {
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// ── Virtuals ──────────────────────────────────────────────────────────────────

GymSchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'gymId'
});

GymSchema.virtual('photos', {
  ref: 'Photo',
  localField: '_id',
  foreignField: 'gymId'
});

GymSchema.virtual('crawlMeta', {
  ref: 'CrawlMeta',
  localField: '_id',
  foreignField: 'gymId',
  justOne: true
});

// ── Indexes (declared once, no duplicates) ────────────────────────────────────

GymSchema.index({ opgId:       1 },         { unique: true, sparse: true }); // public canonical id
GymSchema.index({ geoLocation: '2dsphere' });                              // legacy
GymSchema.index({ location:    '2dsphere' }, { sparse: true });            // canonical
GymSchema.index({ slug:        1 },         { unique: true, sparse: true });
GymSchema.index({ googleMapsUrl: 1 });
GymSchema.index({ placeId:     1 },         { sparse: true });             // non-unique (ensureIndexes handles uniqueness via native driver)
GymSchema.index({ lat: 1, lng: 1 });
GymSchema.index({ primaryCategorySlug: 1 });
GymSchema.index({ areaName: 1, primaryCategorySlug: 1 });
GymSchema.index({ name: 'text', description: 'text', areaName: 'text' });
GymSchema.index({ areaName: 1, category: 1 });
GymSchema.index({ rating: -1 });
GymSchema.index({ qualityScore: -1 });
GymSchema.index({ sentimentScore: -1 });
GymSchema.index({ 'crawlMeta.crawlStatus': 1 });
GymSchema.index({ 'atlas.isListed': 1 });
GymSchema.index({ chainSlug: 1 });
GymSchema.index({ isChainMember: 1 });

// ── Completeness helper ───────────────────────────────────────────────────────

GymSchema.methods.calcCompleteness = function () {
  const checks = [
    this.name, this.lat, this.lng, this.address,
    this.contact?.phone, this.contact?.website,
    this.rating, this.totalReviews,
    this.openingHours?.length > 0,
    this.photos?.length > 0,
    this.description, this.category,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((filled / checks.length) * 100);
};

module.exports = mongoose.model('Gym', GymSchema);
