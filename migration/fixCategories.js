'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const cfg = require('/Users/fakhruddin/root/opg/atlas/config');
const Space = require('/Users/fakhruddin/root/opg/atlas/src/db/spaceModel');
const Category = require('/Users/fakhruddin/root/opg/atlas/src/db/categoryModel');

const CATEGORY_MAP = {
  gym:          'gym',
  yoga:         'yoga_studio',
  crossfit:     'crossfit',
  pilates:      'pilates_studio',
  martial:      'martial_arts',
  boxing:       'boxing_gym',
  karate:       'martial_arts',
  taekwondo:    'martial_arts',
  dance:        'dance_studio',
  swim:         'swimming_club',
  climb:        'climbing_gym',
  boulder:      'climbing_gym',
  'health club':'health_club',
  fitness:      'fitness_center',
  cowork:       'coworking_space',
  office:       'coworking_space',
  cycle:        'cycling_studio',
  spinning:     'cycling_studio',
  zumba:        'fitness_center',
  functional:   'fitness_center',
  trainer:      'personal_trainer',
  strength:     'gym',
};

function mapCat(raw = '', name = '') {
  const l = (raw || '').toLowerCase().trim();
  for (const [k, v] of Object.entries(CATEGORY_MAP)) {
    if (l.includes(k)) return v;
  }
  const nl = (name || '').toLowerCase().trim();
  for (const [k, v] of Object.entries(CATEGORY_MAP)) {
    if (nl.includes(k)) return v;
  }
  return 'fitness_venue';
}

function formatLabel(slug) {
  return slug
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function migrate() {
  await mongoose.connect(cfg.mongo.uri, { dbName: cfg.mongo.dbName });
  console.log('Connected to DB:', cfg.mongo.dbName);

  const spaces = await Space.find({}, { _id: 1, name: 1, category: 1, primaryType: 1, categories: 1 });
  console.log('Total spaces to check:', spaces.length);

  // Pre-create/upsert all standard categories
  const standardSlugs = [
    'gym', 'fitness_center', 'coworking_space', 'yoga_studio',
    'pilates_studio', 'martial_arts', 'boxing_gym', 'dance_studio',
    'swimming_club', 'personal_trainer', 'climbing_gym', 'crossfit', 'fitness_venue'
  ];

  const catMap = {};
  for (const slug of standardSlugs) {
    const label = formatLabel(slug);
    const catDoc = await Category.findOneAndUpdate(
      { slug },
      { $set: { label } },
      { upsert: true, new: true }
    );
    catMap[slug] = catDoc._id;
  }

  let updatedCount = 0;
  const bulkOps = [];

  for (const s of spaces) {
    const raw = s.primaryType || (s.categories && s.categories[0]) || s.category || '';
    const mappedSlug = mapCat(raw, s.name);
    const categoryId = catMap[mappedSlug] || null;

    bulkOps.push({
      updateOne: {
        filter: { _id: s._id },
        update: {
          $set: {
            category: mappedSlug,
            primaryCategorySlug: mappedSlug,
            ...(categoryId ? { categoryId } : {})
          }
        }
      }
    });

    if (bulkOps.length >= 200) {
      await Space.bulkWrite(bulkOps);
      updatedCount += bulkOps.length;
      bulkOps.length = 0;
    }
  }

  if (bulkOps.length > 0) {
    await Space.bulkWrite(bulkOps);
    updatedCount += bulkOps.length;
  }

  console.log('Successfully updated', updatedCount, 'spaces with verified categories!');

  // Check the new aggregate
  const agg = await Space.aggregate([
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  console.log('New Category Aggregate:');
  let sum = 0;
  for (const row of agg) {
    console.log(' ', row._id.padEnd(20), ':', row.count);
    sum += row.count;
  }
  console.log('Total aggregated:', sum);

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
