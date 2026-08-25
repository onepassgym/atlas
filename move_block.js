const fs = require('fs');
const file = 'dashboard/src/pages/Overview.jsx';
let content = fs.readFileSync(file, 'utf8');

const matrixStart = content.indexOf('{/* ── Intel Matrix ────── */}');
const chartsStart = content.indexOf('{/* ── Charts ────── */}');

if (matrixStart === -1 || chartsStart === -1) {
  console.error("Couldn't find markers");
  process.exit(1);
}

const matrixBlock = content.substring(matrixStart, chartsStart);

// Remove the matrix block from its original position
content = content.replace(matrixBlock, '');

// Find where to insert it: below "Crawl Queue Paused Warning" block
const insertMarker = '{/* ── Health Recommendations (Phase 4) ────── */}';
const insertPos = content.indexOf(insertMarker);

if (insertPos === -1) {
  console.error("Couldn't find insert marker");
  process.exit(1);
}

// Insert before the marker
content = content.substring(0, insertPos) + matrixBlock + content.substring(insertPos);

fs.writeFileSync(file, content);
console.log("Moved Intel Matrix successfully!");
