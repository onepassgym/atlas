'use strict';
/**
 * cleanAvatarPhotos.js — remove Google reviewer avatars stored as venue photos
 *
 * Until 2026-09 the photo collectors read every <img> on the Maps panel,
 * including reviewer profile pictures (lh3.googleusercontent.com/a-/… and
 * /a/…), so reviewers' faces ended up in space_photos, rawPhotoUrls and even
 * as coverPhoto. The scraper now filters them; this cleans existing data.
 *
 *   node scripts/cleanAvatarPhotos.js           # dry run — counts only
 *   node scripts/cleanAvatarPhotos.js --apply   # delete / repair
 *
 * On --apply:
 *   • deletes avatar rows from space_photos
 *   • pulls avatar URLs from spaces.rawPhotoUrls and recomputes totalPhotos
 *   • replaces an avatar coverPhoto with the first remaining real photo (or unsets it)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../src/db/connection');
const Space = require('../src/db/spaceModel');
const Photo = require('../src/db/photoModel');

const AVATAR_RX = /googleusercontent\.com\/a-?\//;
const APPLY = process.argv.includes('--apply');

(async () => {
  await connectDB();

  const photoRows = await Photo.countDocuments({ originalUrl: AVATAR_RX });
  const rawSpaces = await Space.countDocuments({ rawPhotoUrls: AVATAR_RX });
  const coverSpaces = await Space.countDocuments({ 'coverPhoto.publicUrl': AVATAR_RX });
  console.log(`Avatar rows in space_photos:        ${photoRows}`);
  console.log(`Spaces with avatars in rawPhotoUrls: ${rawSpaces}`);
  console.log(`Spaces with an avatar as cover:      ${coverSpaces}`);

  if (!APPLY) {
    console.log('\nDry run — nothing changed. Re-run with --apply to clean.');
    await mongoose.disconnect();
    process.exit(0); // connection.js keeps a reconnect handler alive
  }

  const del = await Photo.deleteMany({ originalUrl: AVATAR_RX });
  console.log(`\nDeleted ${del.deletedCount} avatar photo rows`);

  let repaired = 0;
  const cursor = Space.find({ $or: [{ rawPhotoUrls: AVATAR_RX }, { 'coverPhoto.publicUrl': AVATAR_RX }] })
    .select('rawPhotoUrls coverPhoto').lean().cursor();
  for await (const s of cursor) {
    const clean = (s.rawPhotoUrls || []).filter(u => !AVATAR_RX.test(u));
    const $set = { rawPhotoUrls: clean, totalPhotos: clean.length };
    const $unset = {};
    if (AVATAR_RX.test(s.coverPhoto?.publicUrl || '')) {
      if (clean[0]) $set['coverPhoto.publicUrl'] = clean[0];
      else $unset.coverPhoto = '';
    }
    await Space.updateOne({ _id: s._id }, Object.keys($unset).length ? { $set, $unset } : { $set }, { timestamps: false });
    repaired++;
  }
  console.log(`Repaired ${repaired} space documents`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
