'use strict';
/**
 * fixStuckJobs.js — Recover orphaned BullMQ active-list jobs
 *
 * When a worker process crashes mid-job, the BullMQ active list retains the
 * job ID but the lock key expires. BullMQ's stalled detector is supposed to
 * move these back to `wait`, but only fires after stalledInterval (15 min).
 * If the lock renewal keeps erroring (ghost worker still alive but broken),
 * the stalled detector never fires.
 *
 * This script:
 *   1. Scans `atlas-crawl:active` for all job IDs
 *   2. Checks whether each job's lock key exists in Redis
 *   3. Lock GONE → job is orphaned → moves it back to `wait`
 *   4. Resets CrawlJob DB records to 'queued' so the worker picks them up
 *
 * Usage:
 *   node scripts/fixStuckJobs.js [--dry-run]
 */
require('dotenv').config();

const Redis    = require('ioredis');
const cfg      = require('../config');
const { connectDB, disconnectDB } = require('../src/db/connection');
const CrawlJob = require('../src/db/crawlJobModel');

const DRY_RUN = process.argv.includes('--dry-run');

const redis = new Redis({
  host:     cfg.redis.host,
  port:     cfg.redis.port,
  password: cfg.redis.password || undefined,
  connectTimeout:       5000,
  maxRetriesPerRequest: 2,
});

// BullMQ v5 key schema:
//   active list: bull:{queue}:active
//   job data:    bull:{queue}:{jobId}  (hash)
//   lock key:    bull:{queue}:{jobId}:lock  (string with TTL)
//   wait list:   bull:{queue}:wait
const QUEUE      = 'atlas-crawl';
const ACTIVE_KEY = `bull:${QUEUE}:active`;
const WAIT_KEY   = `bull:${QUEUE}:wait`;

async function getJobName(jobId) {
  try {
    return (await redis.hget(`bull:${QUEUE}:${jobId}`, 'name')) || '?';
  } catch (_) { return '?'; }
}

async function getJobInputSummary(jobId) {
  try {
    const raw = await redis.hget(`bull:${QUEUE}:${jobId}`, 'data');
    if (!raw) return '';
    const d = JSON.parse(raw);
    return d.input?.cityName || d.input?.gymName || d.input?.name || '';
  } catch (_) { return ''; }
}

async function main() {
  console.log(`\n🔍 Scanning ${DRY_RUN ? '[DRY RUN] ' : ''}BullMQ queue: ${QUEUE}`);
  console.log(`   Redis: ${cfg.redis.host}:${cfg.redis.port}\n`);

  await connectDB();

  const activeIds = await redis.lrange(ACTIVE_KEY, 0, -1);
  console.log(`📋 Active list: ${activeIds.length} job(s)`);

  if (activeIds.length === 0) {
    console.log('✅ Queue is already clean.');
    return cleanup();
  }

  let recovered = 0;
  let healthy   = 0;

  for (const jobId of activeIds) {
    const lockKey = `bull:${QUEUE}:${jobId}:lock`;
    const lockVal = await redis.get(lockKey);
    const jobName = await getJobName(jobId);
    const summary = await getJobInputSummary(jobId);
    const label   = `${jobName}${summary ? ` [${summary}]` : ''} (${jobId.slice(0, 8)}…)`;

    if (lockVal) {
      const ttl = await redis.ttl(lockKey);
      console.log(`  ✅ ${label} — lock alive (TTL: ${ttl}s)`);
      healthy++;
    } else {
      console.log(`  🧟 ORPHANED: ${label} — lock MISSING/EXPIRED`);
      if (!DRY_RUN) {
        // Remove from active, push to front of wait
        await redis.lrem(ACTIVE_KEY, 0, jobId);
        await redis.lpush(WAIT_KEY, jobId);
        // Reset the CrawlJob document
        await CrawlJob.findOneAndUpdate(
          { jobId },
          { status: 'queued', $unset: { startedAt: 1, bullJobId: 1 } }
        ).catch(() => {});
        console.log(`     ↩️  Moved back to wait queue`);
      } else {
        console.log(`     [dry-run] Would move to wait`);
      }
      recovered++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Scanned:  ${activeIds.length}`);
  console.log(`   Healthy:  ${healthy}`);
  console.log(`   Recovered: ${recovered}`);

  if (recovered > 0 && !DRY_RUN) {
    console.log(`\n✅ Done! ${recovered} job(s) re-queued. Start the worker to pick them up.`);
  } else if (recovered > 0) {
    console.log(`\n[dry-run] Run without --dry-run to fix them.`);
  } else {
    console.log(`\n✅ No orphaned jobs found.`);
  }

  return cleanup();
}

async function cleanup() {
  try { await redis.quit(); } catch (_) {}
  await disconnectDB();
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
