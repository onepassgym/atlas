'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

// ── Relative-date parser ──────────────────────────────────────────────────────
// Converts Google's "X weeks ago" style strings to an ISODate.
// Fallback: current timestamp when string is unrecognised.

function parseRelativeDate(raw) {
  if (!raw || typeof raw !== 'string') return new Date();

  const s   = raw.trim().toLowerCase();
  const now = Date.now();

  // "just now" / "moments ago"
  if (/just now|moments? ago/.test(s)) return new Date(now);

  const match = s.match(/^(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!match) return new Date(now);

  const qty  = (match[1] === 'a' || match[1] === 'an') ? 1 : parseInt(match[1], 10);
  const unit = match[2];

  const MS = {
    second: 1_000,
    minute: 60_000,
    hour:   3_600_000,
    day:    86_400_000,
    week:   7  * 86_400_000,
    month:  30 * 86_400_000,
    year:   365 * 86_400_000,
  };

  return new Date(now - qty * MS[unit]);
}

// ── Schema ────────────────────────────────────────────────────────────────────

const ReviewSchema = new mongoose.Schema(
  {
    spaceId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true },
    // Denormalized public identifier — populated at write time from parent space.
    // Never used for $lookup or joins; spaceId (ObjectId) is always the join key.
    opgId:        { type: String, index: true, uppercase: true, trim: true },
    reviewId:     { type: String, required: true },

    authorName:   String,
    authorUrl:    String,
    authorAvatar: String,   // reviewer avatar URL (no download)
    reviewerLocalGuideLevel: { type: Number, default: null },  // null = not a local guide

    rating:       { type: Number, min: 1, max: 5 },
    text:         String,
    photos:       [String],         // legacy — kept for compat
    reviewPhotos: [String],         // enrichment: URL-only photo list, sourceType=review_photo

    // Keep the raw string Google gives us (e.g. "a month ago")
    publishedAtRaw: String,

    // Parsed ISODate
    publishedAt:  Date,

    likes:        { type: Number, default: 0 },

    ownerReply: {
      text:           String,
      respondedAtRaw: String,     // raw Google string e.g. "2 months ago"
      publishedAt:    Date,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },  // add updatedAt for ownerReply tracking
    collection: cfg.collections.spaceReviews,
    autoIndex: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// Primary indexes are created imperatively in ensureIndexes.js so they are
// guaranteed to exist before the first write.  We still declare them here
// for Mongoose's schema introspection / IDE support.
ReviewSchema.index({ spaceId: 1 });
ReviewSchema.index({ reviewId: 1 }, { unique: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert an array of raw review objects (as scraped) into properly-shaped
 * documents ready for insertion into the `reviews` collection.
 *
 * @param {ObjectId} spaceId
 * @param {Array}    rawReviews  — array of review objects from the scraper
 * @returns {Array}
 */
function buildReviewDocs(spaceId, rawReviews = []) {
  return rawReviews.map((r) => ({
    spaceId,
    reviewId:     r.reviewId   || r.id || String(Math.random()),
    authorName:   r.authorName || r.author || null,
    authorUrl:    r.authorUrl   || null,
    authorAvatar: r.authorAvatar || r.avatar || null,
    reviewerLocalGuideLevel: r.reviewerLocalGuideLevel ?? null,
    rating:       r.rating      || null,
    text:         r.text        || r.body  || null,
    photos:       Array.isArray(r.photos) ? r.photos : [],
    reviewPhotos: Array.isArray(r.reviewPhotos) ? r.reviewPhotos : [],
    publishedAtRaw: r.publishedAt || r.publishedAtRaw || null,
    publishedAt:  parseRelativeDate(r.publishedAt || r.publishedAtRaw),
    likes:        r.likes || 0,
    ownerReply: r.ownerReply?.text
      ? {
          text:           r.ownerReply.text || null,
          respondedAtRaw: r.ownerReply.respondedAt || r.ownerReply.publishedAt || null,
          publishedAt:    r.ownerReply.respondedAt || r.ownerReply.publishedAt
            ? parseRelativeDate(r.ownerReply.respondedAt || r.ownerReply.publishedAt)
            : null,
        }
      : undefined,
  }));
}

/**
 * Merge updated review fields into an existing review document.
 * Used by enrichment pass to update ownerReply if it changed.
 *
 * @param {ObjectId} spaceId
 * @param {Array}    rawReviews
 * @param {Object}   changeLogWriter — function(spaceId, diffs, now) for logging ownerResponse changes
 * @returns {{ updated: number }}
 */
async function mergeReviewEnrichment(spaceId, rawReviews = [], changeLogWriter) {
  if (!rawReviews.length) return { updated: 0 };
  let updated = 0;
  const now = new Date();

  for (const r of rawReviews) {
    const id = r.reviewId || r.id;
    if (!id) continue;

    const existing = await Review.findOne({ reviewId: id }).lean();
    if (!existing) continue;

    const updates = {};
    // Update ownerReply if text changed
    const newReplyText = r.ownerReply?.text || null;
    const oldReplyText = existing.ownerReply?.text || null;
    if (newReplyText && newReplyText !== oldReplyText) {
      updates.ownerReply = {
        text:           newReplyText,
        respondedAtRaw: r.ownerReply?.respondedAt || r.ownerReply?.publishedAt || null,
        publishedAt:    parseRelativeDate(r.ownerReply?.respondedAt || r.ownerReply?.publishedAt),
      };
      // Log the owner response change
      if (changeLogWriter) {
        await changeLogWriter(spaceId, [{
          field:    'ownerResponse',
          oldValue: oldReplyText,
          newValue: newReplyText,
        }], now);
      }
    }
    // Update reviewPhotos if new ones appeared
    if (Array.isArray(r.reviewPhotos) && r.reviewPhotos.length > (existing.reviewPhotos?.length || 0)) {
      updates.reviewPhotos = r.reviewPhotos;
    }
    // Update local guide level if newly available
    if (r.reviewerLocalGuideLevel != null && existing.reviewerLocalGuideLevel == null) {
      updates.reviewerLocalGuideLevel = r.reviewerLocalGuideLevel;
    }

    if (Object.keys(updates).length) {
      await Review.updateOne({ reviewId: id }, { $set: updates });
      updated++;
    }
  }
  return { updated };
}

const Review = mongoose.model('Review', ReviewSchema);

module.exports = { Review, buildReviewDocs, parseRelativeDate, mergeReviewEnrichment };
