'use strict';
require('dotenv').config();
const fs = require('fs');
const { connectDB, disconnectDB } = require('../src/db/connection');
const Space = require('../src/db/spaceModel');
const CrawlJob = require('../src/db/crawlJobModel');
const logger   = require('../src/utils/logger');

async function main() {
  await connectDB();
  const doExport = process.argv.includes('--export');

  const [total, byCategory, topCities, avgRating, avgComplete, totalPhotos, totalReviews, totalJobs, jobsByStatus] =
    await Promise.all([
      Space.countDocuments(),
      Space.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Space.aggregate([{ $group: { _id: '$areaName', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 20 }]),
      Space.aggregate([{ $match: { rating: { $gt: 0 } } }, { $group: { _id: null, avg: { $avg: '$rating' } } }]),
      Space.aggregate([{ $group: { _id: null, avg: { $avg: '$crawlMeta.dataCompleteness' } } }]),
      Space.aggregate([{ $group: { _id: null, t: { $sum: '$totalPhotos' } } }]),
      Space.aggregate([{ $group: { _id: null, t: { $sum: '$totalReviews' } } }]),
      CrawlJob.countDocuments(),
      CrawlJob.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

  console.log('\n══════════════════════════════════════════');
  console.log('   atlas  ·  Database Statistics');
  console.log('══════════════════════════════════════════');
  console.log(`  Total Gyms         ${total.toLocaleString()}`);
  console.log(`  Avg Rating         ${avgRating[0]?.avg?.toFixed(2) || 'N/A'}`);
  console.log(`  Avg Completeness   ${avgComplete[0]?.avg?.toFixed(1) || 0}%`);
  console.log(`  Total Photos       ${(totalPhotos[0]?.t || 0).toLocaleString()}`);
  console.log(`  Total Reviews      ${(totalReviews[0]?.t || 0).toLocaleString()}`);
  console.log(`  Crawl Jobs         ${totalJobs}`);
  console.log('\n  By Category:');
  byCategory.forEach(c => console.log(`    ${(c._id || 'unknown').padEnd(26)} ${c.count}`));
  console.log('\n  Top Cities:');
  topCities.forEach(c => console.log(`    ${(c._id || 'unknown').padEnd(35)} ${c.count}`));
  console.log('\n  Jobs by Status:');
  jobsByStatus.forEach(j => console.log(`    ${(j._id || 'unknown').padEnd(15)} ${j.count}`));
  console.log('══════════════════════════════════════════\n');

  if (doExport) {
    logger.info('Exporting to gyms-export.json...');
    const gyms = await Space.find().select('-reviews -photos.localPath').lean();
    fs.writeFileSync('gyms-export.json', JSON.stringify(gyms, null, 2));
    logger.info(`Exported ${gyms.length} gyms.`);
  }

  await disconnectDB();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
