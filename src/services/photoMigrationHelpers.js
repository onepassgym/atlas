'use strict';
/**
 * photoMigrationHelpers.js
 *
 * Shared logic for building photo bulkWrite ops and collecting/deduplicating
 * photos from space documents. Used by both photoSyncService.js and
 * POST /api/media/migrate-from-spaces in mediaRoutes.js.
 */

const path = require('path');
const cfg  = require('../../config');

/**
 * Build a single bulkWrite upsert op for one photo.
 * Handles both rawPhotos entries and standalone coverPhoto records.
 */
function buildOp(spaceId, spaceSlug, p, isCover) {
  let folder = `photos/${spaceSlug}`;
  if (p.localPath) {
    try {
      folder = path.dirname(
        path.relative(path.resolve(cfg.media.basePath), p.localPath)
      ).replace(/\\/g, '/');
    } catch (_) { /* keep default */ }
  }

  const filename = p.localPath
    ? path.basename(p.localPath)
    : path.basename((p.publicUrl || 'photo.jpg').split('?')[0]);

  return {
    updateOne: {
      filter: { publicUrl: p.publicUrl },
      update: {
        $setOnInsert: {
          spaceId,
          originalUrl:  p.originalUrl  || null,
          localPath:    p.localPath    || null,
          publicUrl:    p.publicUrl,
          thumbnailUrl: p.thumbnailUrl || null,
          filename,
          folder,
          type:         p.type         || 'photo',
          width:        p.width        ?? null,
          height:       p.height       ?? null,
          sizeBytes:    p.sizeBytes    ?? null,
          mimeType:     p.mimeType     || null,
          appealScore:  p.appealScore  || 0,
          brightness:   p.brightness   || null,
          contrast:     p.contrast     || null,
          tags:         Array.isArray(p.tags) ? p.tags : [],
          isCover:      Boolean(isCover),
          downloadedAt: p.downloadedAt ? new Date(p.downloadedAt) : null,
          fsExists:     true,
          createdAt:    p.downloadedAt ? new Date(p.downloadedAt) : new Date(),
        },
        $set: { spaceId, ...(isCover ? { isCover: true } : {}) },
      },
      upsert: true,
    },
  };
}

/**
 * Collect and deduplicate all photos for a single space.
 * rawPhotos is the primary source; coverPhoto supplements it.
 * Returns a Map<publicUrl, {p, isCover}>.
 */
function collectPhotos(space) {
  const photoMap = new Map();

  // 1 — rawPhotos
  if (Array.isArray(space.rawPhotos)) {
    for (const p of space.rawPhotos) {
      if (!p || typeof p !== 'object' || !p.publicUrl) continue;
      photoMap.set(p.publicUrl, { p, isCover: false });
    }
  }

  // 2 — coverPhoto (merge or add)
  if (space.coverPhoto?.publicUrl) {
    const existing = photoMap.get(space.coverPhoto.publicUrl);
    if (existing) {
      existing.isCover        = true;
      existing.p.width        = existing.p.width        ?? space.coverPhoto.width        ?? null;
      existing.p.height       = existing.p.height       ?? space.coverPhoto.height       ?? null;
      existing.p.thumbnailUrl = existing.p.thumbnailUrl ?? space.coverPhoto.thumbnailUrl ?? null;
    } else {
      photoMap.set(space.coverPhoto.publicUrl, {
        p: {
          publicUrl:    space.coverPhoto.publicUrl,
          thumbnailUrl: space.coverPhoto.thumbnailUrl || null,
          width:        space.coverPhoto.width        ?? null,
          height:       space.coverPhoto.height       ?? null,
          originalUrl:  null,
          localPath:    null,
          type:         'photo',
          sizeBytes:    null,
          downloadedAt: null,
        },
        isCover: true,
      });
    }
  }

  return photoMap;
}

module.exports = { buildOp, collectPhotos };
