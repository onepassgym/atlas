const fs = require('fs');
const path = require('path');

const files = [
  'dashboard/src/index.css',
  'dashboard/src/pages/MediaStorage.jsx',
  'src/scraper/enrichmentProcessor.js',
  'src/queue/worker.js',
  'src/queue/queues.js',
  'src/queue/enrichmentWorker.js',
  'src/db/ensureIndexes.js',
  'src/db/crawlJobModel.js',
  'src/api/mediaRoutes.js',
  'src/api/crawlRoutes.js',
  'src/api/spaceRoutes.js',
  'src/services/photoSyncService.js',
  'src/services/schedulerService.js'
];

const replacements = [
  { from: /gym_name/g, to: 'space_name' },
  { from: /gym_photos/g, to: 'space_photos' },
  { from: /DELAY_BETWEEN_GYMS/g, to: 'DELAY_BETWEEN_SPACES' },
  { from: /GYMS_PER_RUN/g, to: 'SPACES_PER_RUN' },
  { from: /gyms_/g, to: 'spaces_' }, // in ensureIndexes.js
  { from: /gym_categories/g, to: 'space_categories' },
  { from: /gym_reviews/g, to: 'space_reviews' },
  { from: /gym_chains/g, to: 'space_chains' },
  { from: /gymId/g, to: 'spaceId' }
];

for (const relPath of files) {
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;
  
  let content = fs.readFileSync(fullPath, 'utf8');
  let originalContent = content;

  for (const rule of replacements) {
    content = content.replace(rule.from, rule.to);
  }

  if (content !== originalContent) {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`Updated content: ${relPath}`);
  }
}
