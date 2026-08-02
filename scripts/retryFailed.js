'use strict';
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { connectDB, disconnectDB } = require('../src/db/connection');
const { addCityJob, addGymNameJob } = require('../src/queue/queues');
const CrawlJob = require('../src/db/crawlJobModel');
const Space = require('../src/db/spaceModel');
const logger   = require('../src/utils/logger');

async function retryFailed() {
  await connectDB();
  const failed = await CrawlJob.find({ status: { $in: ['failed','partial'] }, type: 'city' }).lean();
  logger.info(`Found ${failed.length} failed/partial jobs to retry`);
  for (const j of failed) {
    const jobId = uuidv4();
    await CrawlJob.create({ jobId, type: 'city', input: j.input, status: 'queued' });
    await addCityJob(jobId, j.input.cityName, j.input.categories || []);
    logger.info(`Re-queued: ${j.input.cityName} → ${jobId}`);
  }
  await disconnectDB(); process.exit(0);
}

async function retryIncomplete(threshold = 50) {
  await connectDB();
  const gyms = await Space.find({ 'crawlMeta.dataCompleteness': { $lt: threshold } }).select('name areaName googleMapsUrl').limit(200).lean();
  logger.info(`Found ${gyms.length} gyms with completeness < ${threshold}%`);
  for (const g of gyms) {
    const jobId = uuidv4();
    await addGymNameJob(jobId, `${g.name} ${g.areaName || ''}`);
    logger.info(`Re-queued: ${g.name}`);
  }
  await disconnectDB(); process.exit(0);
}

const mode = process.argv[2];
if (mode === '--incomplete') retryIncomplete(parseInt(process.argv[3] || '50', 10));
else retryFailed();
