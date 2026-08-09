'use strict';
const mongoose = require('mongoose');

// Register related models for population
require('./categoryModel');
require('./amenityModel');
require('./reviewModel');
require('./photoModel');

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
  phone2:     String,
  website:    String,
  email:      String,
  whatsapp:   String,
  instagram:  String,
  facebook:   String,
  youtube:    String,
  bookingUrl: String,
  menuUrl:    String,
}, { _id: false });

// ── Main Schema — matches v5 opg-atlas.spaces ─────────────────────────────────

const SpaceSchema = new mongoose.Schema({
  // Public canonical identifier — SPC-WORD-base32tail
  opgId: {
    type:   String,
    unique: true,
    sparse: true,
    index:  true,
    trim:   true,
    match:  /^SPC-[A-Z]+-[0-9A-Z]{11,14}$/,
  },

  // Identity
  placeId:       { type: String, sparse: true },
  googleMapsUrl: String,
  name:          { type: String, required: true },
  slug:          { type: String, unique: true, sparse: true },
  aliases:       [String],

  // Classification (v5 normalized)
  primaryCategorySlug: { type: String, index: true },
  categorySlugs:       [String],
  amenitySlugs:        [String],
  tags:                [String],
  chainOpgId:          { type: String, default: null, index: true },

  // Location (v5: normalized + denorm display)
  cityOpgId:  { type: String, index: true },
  areaOpgId:  { type: String, index: true },
  location:   { type: GeoPointSchema },     // canonical GeoJSON 2dsphere
  address:    String,
  areaName:   String,                       // denorm display
  city:       String,                       // denorm display
  state:      String,
  pincode:    String,
  plusCode:    String,
  country:    { type: String, default: 'IN' },

  // Contact
  contact: ContactSchema,

  // Ratings
  rating:       Number,
  totalReviews: { type: Number, default: 0 },
  reviewsScraped: { type: Number, default: 0 },
  ratingBreakdown: {
    fiveStar:  { type: Number, default: 0 },
    fourStar:  { type: Number, default: 0 },
    threeStar: { type: Number, default: 0 },
    twoStar:   { type: Number, default: 0 },
    oneStar:   { type: Number, default: 0 },
  },
  sentimentScore: { type: Number, default: 0 },
  sentimentTags:  {
    positive: [String],
    negative: [String],
  },

  // Media — URL-first (no binaries by default)
  coverAssetOpgId: String,                // cross-DB ref to opg-media
  coverUrl:        String,                // denorm rendered url
  rawPhotoUrls:    [String],              // all scraped image URLs
  totalPhotos:     { type: Number, default: 0 },

  // Details
  description:    String,
  priceLevel:     { type: String, enum: ['budget', 'mid', 'premium', null] },
  openingHours:   [HoursSchema],
  isOpenNow:      Boolean,
  highlights:     [String],
  offerings:      [String],
  serviceOptions: [String],
  accessibility:  [String],

  // OPG marketplace flags (v5 opg{} object)
  opg: {
    isListed:    { type: Boolean, default: false },
    isVerified:  { type: Boolean, default: false },
    isPartner:   { type: Boolean, default: false },
    isFeatured:  { type: Boolean, default: false },
    planSlugs:   [String],
  },

  // Quality & Search (v5)
  qualityScore:    { type: Number, default: 0, index: true },
  scoreBreakdown:  mongoose.Schema.Types.Mixed,
  dataCompleteness:{ type: Number, default: 0, index: true },
  searchBoost:     { type: Number, default: 1.0 },

  // Crawl (v5: embedded object replaces separate crawl_meta collection)
  crawl: {
    jobId:          String,
    status:         { type: String, enum: ['pending', 'in_progress', 'completed', 'failed', 'partial'], default: 'pending' },
    version:        { type: Number, default: 1 },
    firstCrawledAt: Date,
    lastCrawledAt:  Date,
    sourceUrl:      String,
  },

  // Multi-source tracking — which data sources contributed to this record
  sources: {
    type: [String],
    default: [],
    index: true,
  }, // e.g. ['google_maps', 'justdial', 'osm', 'official_website', 'yelp']

  // Enrichment (v5 + graph pipeline: stage 0–7)
  enrichment: {
    status:            { type: String, enum: ['success', 'failed', 'never', 'quarantined'], default: 'never' },
    // Graph pipeline stage: 0=base crawl, 1=multi-source, 2=website deep,
    // 3=social signals, 4=review mining, 5=media harvest, 6=AI intelligence, 7=quality lock
    stage:             { type: Number, default: 0, min: 0, max: 7, index: true },
    stageCompletedAt:  { type: [Date], default: [] }, // one entry per completed stage
    stageErrors:       { type: [String], default: [] }, // error message per stage or null
    nextEnrichAt:      { type: Date, default: null, index: true }, // scheduled re-enrichment
    lastSuccess:       Date,
    lastAttempt:       Date,
    consecutiveErrors: { type: Number, default: 0 },
    error:             String,
  },

  // OPG marketplace flags (v5)
  acceptsWalkIn: { type: Boolean, default: false },
  hasClasses:    { type: Boolean, default: false },

  // Typesense semantic index text (generated in Stage 6 by LLM)
  embedText: String,

  // Pipeline state
  parsed: { type: Boolean, default: false },

  // Provenance
  createdVia: { type: String, default: 'crawler' },
  deletedAt:  { type: Date, default: null },

  // ── Rebuild pipeline fields (Phase 0+) ───────────────────────────────────
  validationState: {
    type: String,
    enum: ['raw', 'draft', 'validated', 'published', 'archived'],
    default: 'raw',
    index: true,
  },
  // field-level confidence: { geo: { confidence, source, capturedAt }, ... }
  fieldConfidence: { type: Map, of: mongoose.Schema.Types.Mixed, default: undefined },
  rawType:         String,    // original Maps/OSM type when no taxonomy mapping exists
  publishedToCore: { type: Boolean, default: false, index: true },
  lastSyncedToCore: Date,
  publishedAt:     Date,

  // Legacy compat fields (kept for migration, will be removed post-backfill)
  lat: Number,
  lng: Number,
}, {
  timestamps: true,
  collection: 'spaces',
  autoIndex: false,
  toJSON: {
    virtuals: true,
    transform: (doc, ret) => {
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
  toObject: { virtuals: true },
});

// ── Virtuals ──────────────────────────────────────────────────────────────────

SpaceSchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'spaceId',
});

SpaceSchema.virtual('photos', {
  ref: 'Photo',
  localField: '_id',
  foreignField: 'spaceId',
});

// ── Indexes (v5 compound indexes) ─────────────────────────────────────────────

SpaceSchema.index({ opgId: 1 },           { unique: true, sparse: true });
SpaceSchema.index({ location: '2dsphere' }, { sparse: true });
SpaceSchema.index({ slug: 1 },            { unique: true, sparse: true });
SpaceSchema.index({ googleMapsUrl: 1 });
SpaceSchema.index({ placeId: 1 },         { sparse: true });
SpaceSchema.index({ 'contact.phone': 1 }, { sparse: true });
SpaceSchema.index({ name: 'text', description: 'text', areaName: 'text' });

// v5 compound indexes
SpaceSchema.index({ cityOpgId: 1, primaryCategorySlug: 1, qualityScore: -1 }, { name: 'idx_city_cat_quality' });
SpaceSchema.index({ city: 1, primaryCategorySlug: 1 },                        { name: 'idx_city_cat_display' });
SpaceSchema.index({ rating: -1, qualityScore: -1 },                           { name: 'idx_rank' });

// Operational indexes
SpaceSchema.index({ chainOpgId: 1 },        { sparse: true });
SpaceSchema.index({ 'crawl.status': 1 });
SpaceSchema.index({ 'enrichment.status': 1 });
SpaceSchema.index({ deletedAt: 1 },         { sparse: true });

module.exports = mongoose.model('Space', SpaceSchema);
