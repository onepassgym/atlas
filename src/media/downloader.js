'use strict';
/**
 * downloader.js — On-demand image download & variant generation
 *
 * Phase 3: URL-first model. This module is ONLY invoked by explicit
 * per-image download actions (API button), never automatically during
 * crawl or enrichment. MEDIA_DOWNLOAD_ENABLED gates even the explicit path.
 *
 * Exports:
 *   downloadAndCreateVariants(url, opts) → { original, thumbnail, og, card, meta }
 */
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const cfg    = require('../../config');
const logger = require('../utils/logger');

const DOWNLOAD_ENABLED = cfg.media.downloadEnabled;

// Lazy-load heavy deps only when actually downloading
let axios = null;
let sharp = null;
let BASE = null;
let PUB_URL = null;
let AX = null;

function ensureDeps() {
  if (!axios) {
    axios = require('axios');
    sharp = require('sharp');
    BASE    = path.resolve(cfg.media.basePath);
    PUB_URL = cfg.media.baseUrl.replace(/\/$/, '');
    AX = axios.create({
      timeout: 25_000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': cfg.scraper.userAgent,
        Referer:      'https://www.google.com/maps',
        Accept:       'image/webp,image/apng,image/*,*/*',
      },
    });
    ['photos', 'thumbnails'].forEach(d => fs.mkdirSync(path.join(BASE, d), { recursive: true }));
  }
}

// ── Variant definitions ────────────────────────────────────────────────────────
const VARIANTS = {
  thumbnail: { width: 400, height: 300, fit: 'cover', quality: 65 },
  og:        { width: 1200, height: 630, fit: 'cover', quality: 80 },
  card:      { width: 600, height: 400, fit: 'cover', quality: 72 },
};

/**
 * Download a single image from source URL, generate variants, return metadata.
 * This is the on-demand path — called only by explicit download actions.
 *
 * @param {string} sourceUrl - Google CDN or other source URL
 * @param {{ slug?: string, spaceOpgId?: string }} opts
 * @returns {{ original: { path, publicUrl, width, height, sizeBytes }, variants: { [name]: { path, publicUrl, width, height } }, meta: { mimeType } }}
 */
async function downloadAndCreateVariants(sourceUrl, opts = {}) {
  if (!DOWNLOAD_ENABLED) {
    throw new Error('MEDIA_DOWNLOAD_ENABLED is false — explicit downloads are disabled');
  }

  ensureDeps();

  const slug = opts.slug || 'space';
  const subdir = path.join('photos', slug);
  const absDir = path.join(BASE, subdir);
  fs.mkdirSync(absDir, { recursive: true });

  const filename = `${uuidv4()}.jpg`;
  const relPath  = path.join(subdir, filename);
  const absPath  = path.join(BASE, relPath);

  // Download source
  const resp   = await AX.get(sourceUrl);
  const buffer = Buffer.from(resp.data);

  // Write original (re-encoded as progressive JPEG)
  const originalMeta = await sharp(buffer)
    .jpeg({ quality: 85, progressive: true })
    .toFile(absPath);

  const original = {
    path: absPath,
    publicUrl: `${PUB_URL}/${relPath.replace(/\\/g, '/')}`,
    width: originalMeta.width,
    height: originalMeta.height,
    sizeBytes: originalMeta.size,
  };

  // Generate variants
  const variants = {};
  for (const [name, spec] of Object.entries(VARIANTS)) {
    const varFilename = `${name}_${filename}`;
    const varRelPath  = path.join(subdir, varFilename);
    const varAbsPath  = path.join(BASE, varRelPath);

    const varMeta = await sharp(buffer)
      .resize(spec.width, spec.height, { fit: spec.fit })
      .jpeg({ quality: spec.quality })
      .toFile(varAbsPath);

    variants[name] = {
      path: varAbsPath,
      publicUrl: `${PUB_URL}/${varRelPath.replace(/\\/g, '/')}`,
      width: varMeta.width,
      height: varMeta.height,
      sizeBytes: varMeta.size,
    };
  }

  return {
    original,
    variants,
    meta: { mimeType: 'image/jpeg', sourceUrl },
  };
}

module.exports = { downloadAndCreateVariants, DOWNLOAD_ENABLED };
