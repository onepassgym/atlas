'use strict';
require('dotenv').config();
const { crawlQueue } = require('../src/queue/queues');
const logger = require('../src/utils/logger');

async function main() {
  logger.info('🧹 Clearing all jobs from the "atlas-crawl" queue...');

  try {
    // Obscure BullMQ version differences: 
    // drain() removes all jobs that are waiting or delayed
    // clean() can be used to remove completed/failed jobs
    
    const countBefore = await crawlQueue.count();
    logger.info(`Found ${countBefore} total jobs.`);

    await crawlQueue.pause();
    await crawlQueue.obliterate({ force: true }); 
    // obliterate is the scorched-earth policy: removes the queue and all its keys
    
    logger.info('✅ Queue obliterated successfully.');
  } catch (err) {
    logger.error('❌ Failed to clear queue: ' + err.message);
  } finally {
    await crawlQueue.close();
    process.exit(0);
  }
}

main();
