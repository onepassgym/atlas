'use strict';
/**
 * enrichmentWorker.js — Graph-Based Enrichment Loop Worker
 *
 * Continuously picks spaces with enrichment.stage < 7 and advances them
 * one stage at a time using the 7-stage DAG defined in EnrichmentGraphService.
 *
 * Loop:
 *   1. Check pause flag
 *   2. Pop priority space (if any)
 *   3. Find next space via getNextSpace()
 *   4. Advance one stage via advanceStage()
 *   5. Brief delay → repeat
 *
 * Stages:
 *   1 = Multi-source cross-ref  |  2 = Website deep  |  3 = Social signals
 *   4 = Review mining  |  5 = Media harvest  |  6 = AI intelligence  |  7 = Quality lock
 */

require('dotenv').config();

const { connectDB } = require('../db/connection');
const { advanceStage, getNextSpace } = require('../services/EnrichmentGraphService');
const {
  isPaused,
  popPrioritySpace,
  setStatus,
  getStatus,
} = require('../services/enrichmentService');
const logger = require('../utils/logger');
const bus    = require('../services/eventBus');

const DELAY_BETWEEN_SPACES = parseInt(process.env.ENRICHMENT_DELAY || '2000', 10);
const PAUSE_POLL_INTERVAL  = 5000;

let isShuttingDown  = false;
let processedTotal  = 0;
let processedToday  = 0;
let todayDate       = new Date().toISOString().slice(0, 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function checkDayRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== todayDate) { todayDate = today; processedToday = 0; }
}

async function runLoop() {
  logger.info('🔄 Enrichment Graph Worker started');

  while (!isShuttingDown) {
    checkDayRollover();

    // Pause check
    if (await isPaused()) {
      await sleep(PAUSE_POLL_INTERVAL);
      continue;
    }

    // Find next space to enrich
    const priorityItem = await popPrioritySpace();
    const priorityOpgId = priorityItem?.spaceId || null;
    const space = await getNextSpace(priorityOpgId);

    if (!space) {
      logger.info('🌙 No spaces to enrich — sleeping 60s');
      await setStatus({ state: 'idle', processedTotal, processedToday });
      await sleep(60_000);
      continue;
    }

    // Advance one stage
    try {
      await setStatus({ state: 'running', currentSpace: space.name, stage: (space.enrichment?.stage || 0) + 1, processedTotal, processedToday });

      const result = await advanceStage(space.opgId);

      if (result.action !== 'already_complete') {
        processedTotal++;
        processedToday++;
        bus.publish('enrichment:progress', {
          spaceOpgId: space.opgId,
          name:       space.name,
          stage:      result.stage,
          durationMs: result.durationMs,
          processedTotal,
          processedToday,
        });
      }
    } catch (err) {
      logger.error(`[EnrichWorker] Failed for ${space.opgId}: ${err.message}`);
    }

    await sleep(DELAY_BETWEEN_SPACES);
  }
}

async function start() {
  await connectDB();
  await runLoop();
}

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`⏳ Enrichment Worker received ${signal} — shutting down after current stage`);
  await setStatus({ state: 'stopped' });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start().catch(err => { logger.error(`Enrichment worker startup failed: ${err.message}`); process.exit(1); });
