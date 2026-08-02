'use strict';
/**
 * opgMediaWriter.js — Writes to the opg-media cluster (media_assets + media_variants)
 *
 * Phase 3: On-demand image ownership.
 * When a user explicitly downloads an image, this module:
 *   1. Fetches the binary via downloader.js (Sharp variants)
 *   2. Creates a media_assets doc (AST-* opgId)
 *   3. Creates media_variants docs (VAR-* opgId) for each variant
 *   4. Flips the space_photos record to downloaded=true, sets assetOpgId + publicUrl
 *   5. Updates spaces.coverUrl if the photo is the cover
 *
 * opg-media is a separate cluster in production. For now (single-DB mode),
 * these collections live in the same atlas DB. When opg-media splits out,
 * only the connection in this file changes.
 */

const mongoose = require('mongoose');
const { makeOpgId } = require('../utils/opgId');
const { downloadAndCreateVariants } = require('./downloader');
const Photo = require('../db/photoModel');
const Space = require('../db/spaceModel');
const logger = require('../utils/logger');

// ── media_assets schema (opg-media cluster) ───────────────────────────────────
const MediaAssetSchema = new mongoose.Schema({
  opgId:      { type: String, unique: true, sparse: true, trim: true },
  bucket:     { type: String, default: 'spaces' },
  source:     { type: String, enum: ['crawl', 'upload', 'import'], default: 'crawl' },
  ownerOpgId: String,        // SPC-* that owns this asset
  mimeType:   { type: String, default: 'image/jpeg' },
  width:      Number,
  height:     Number,
  sizeBytes:  Number,
  publicUrl:  String,        // CDN url for the original
  sourceUrl:  String,        // where we fetched it from
  usageCount: { type: Number, default: 1 },
  createdVia: { type: String, default: 'crawler' },
  deletedAt:  { type: Date, default: null },
}, { timestamps: true, collection: 'media_assets' });

MediaAssetSchema.index({ opgId: 1 }, { unique: true, sparse: true });
MediaAssetSchema.index({ ownerOpgId: 1 });

const MediaAsset = mongoose.models.MediaAsset || mongoose.model('MediaAsset', MediaAssetSchema);

// ── media_variants schema ─────────────────────────────────────────────────────
const MediaVariantSchema = new mongoose.Schema({
  opgId:       { type: String, unique: true, sparse: true, trim: true },
  assetOpgId:  { type: String, index: true },
  variantType: { type: String, enum: ['thumbnail', 'og', 'card', 'original'], required: true },
  mimeType:    { type: String, default: 'image/jpeg' },
  width:       Number,
  height:      Number,
  sizeBytes:   Number,
  publicUrl:   String,
  createdVia:  { type: String, default: 'crawler' },
}, { timestamps: true, collection: 'media_variants' });

MediaVariantSchema.index({ opgId: 1 }, { unique: true, sparse: true });
MediaVariantSchema.index({ assetOpgId: 1 });

const MediaVariant = mongoose.models.MediaVariant || mongoose.model('MediaVariant', MediaVariantSchema);

// ── Rate limiting (prevent abuse of download button) ──────────────────────────
const downloadLimiter = new Map(); // spaceOpgId → { count, resetAt }
const RATE_LIMIT_PER_SPACE = 50;   // max 50 downloads per space per hour
const RATE_LIMIT_WINDOW = 3600_000;

function checkRateLimit(spaceOpgId) {
  const now = Date.now();
  const entry = downloadLimiter.get(spaceOpgId);
  if (!entry || now > entry.resetAt) {
    downloadLimiter.set(spaceOpgId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_PER_SPACE) return false;
  entry.count++;
  return true;
}

/**
 * Download a single photo, create media_assets + variants, flip the photo record.
 *
 * @param {string} photoOpgId - PHT-* id of the space_photos record
 * @param {{ spaceOpgId: string, slug?: string }} context
 * @returns {{ assetOpgId, publicUrl, variants }}
 */
async function downloadPhoto(photoOpgId, context = {}) {
  const photo = await Photo.findOne({ opgId: photoOpgId }).lean();
  if (!photo) throw new Error(`Photo not found: ${photoOpgId}`);
  if (photo.downloaded) throw new Error(`Photo already downloaded: ${photoOpgId}`);
  if (!photo.originalUrl) throw new Error(`No source URL for photo: ${photoOpgId}`);

  const spaceOpgId = context.spaceOpgId || photo.spaceOpgId;
  if (!checkRateLimit(spaceOpgId)) {
    throw new Error(`Rate limit exceeded for space ${spaceOpgId} — max ${RATE_LIMIT_PER_SPACE} downloads/hour`);
  }

  // Download binary + generate variants
  const result = await downloadAndCreateVariants(photo.originalUrl, {
    slug: context.slug || 'space',
    spaceOpgId,
  });

  // Create media_assets record
  const assetOpgId = makeOpgId('photo'); // reuse PHT- prefix for asset cross-ref tracking
  // Actually per v5, assets use AST- prefix. Let's use a direct string:
  const astId = `AST-${makeOpgId('photo').split('-').slice(1).join('-')}`; // AST-WORD-base32

  await MediaAsset.create({
    opgId: astId,
    bucket: 'spaces',
    source: 'crawl',
    ownerOpgId: spaceOpgId,
    mimeType: 'image/jpeg',
    width: result.original.width,
    height: result.original.height,
    sizeBytes: result.original.sizeBytes,
    publicUrl: result.original.publicUrl,
    sourceUrl: photo.originalUrl,
    usageCount: 1,
    createdVia: 'crawler',
  });

  // Create media_variants
  const variantDocs = [];
  for (const [varType, varData] of Object.entries(result.variants)) {
    const varOpgId = `VAR-${makeOpgId('photo').split('-').slice(1).join('-')}`;
    variantDocs.push({
      opgId: varOpgId,
      assetOpgId: astId,
      variantType: varType,
      mimeType: 'image/jpeg',
      width: varData.width,
      height: varData.height,
      sizeBytes: varData.sizeBytes,
      publicUrl: varData.publicUrl,
      createdVia: 'crawler',
    });
  }
  if (variantDocs.length) await MediaVariant.insertMany(variantDocs);

  // Flip space_photos record
  const thumbnailUrl = result.variants.thumbnail?.publicUrl || null;
  await Photo.findOneAndUpdate(
    { opgId: photoOpgId },
    {
      $set: {
        downloaded: true,
        assetOpgId: astId,
        publicUrl: result.original.publicUrl,
        thumbnailUrl,
        width: result.original.width,
        height: result.original.height,
      },
    }
  );

  // If this is the cover photo, update spaces.coverUrl + coverAssetOpgId
  if (photo.isCover && spaceOpgId) {
    await Space.findOneAndUpdate(
      { opgId: spaceOpgId },
      { $set: { coverUrl: result.original.publicUrl, coverAssetOpgId: astId } }
    );
  }

  logger.info(`[MEDIA] Downloaded ${photoOpgId} → asset ${astId} (${result.original.width}x${result.original.height})`);

  return {
    assetOpgId: astId,
    publicUrl: result.original.publicUrl,
    thumbnailUrl,
    variants: Object.fromEntries(
      Object.entries(result.variants).map(([k, v]) => [k, v.publicUrl])
    ),
  };
}

/**
 * Download all un-downloaded photos for a space. Rate-limited and explicit.
 *
 * @param {string} spaceOpgId
 * @returns {{ downloaded: number, failed: number, results: Array }}
 */
async function downloadAllForSpace(spaceOpgId) {
  const space = await Space.findOne({ opgId: spaceOpgId }, { slug: 1 }).lean();
  if (!space) throw new Error(`Space not found: ${spaceOpgId}`);

  const photos = await Photo.find({
    spaceOpgId,
    downloaded: false,
    originalUrl: { $exists: true, $ne: null },
  }).select('opgId originalUrl').lean();

  if (!photos.length) return { downloaded: 0, failed: 0, results: [] };

  let downloaded = 0;
  let failed = 0;
  const results = [];

  for (const photo of photos) {
    try {
      const result = await downloadPhoto(photo.opgId, { spaceOpgId, slug: space.slug });
      results.push({ photoOpgId: photo.opgId, ...result });
      downloaded++;
    } catch (err) {
      results.push({ photoOpgId: photo.opgId, error: err.message });
      failed++;
      // Stop if rate limited
      if (err.message.includes('Rate limit')) break;
    }
  }

  logger.info(`[MEDIA] Batch download for ${spaceOpgId}: ${downloaded} ok, ${failed} failed`);
  return { downloaded, failed, results };
}

module.exports = { downloadPhoto, downloadAllForSpace, MediaAsset, MediaVariant };
