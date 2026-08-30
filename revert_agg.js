const fs = require('fs');
const path = require('path');

const files = [
  'dashboard/src/pages/Overview.jsx',
  'dashboard/src/pages/Explorer.jsx',
  'dashboard/src/pages/GlobePage.jsx',
  'dashboard/src/components/ChangeFeed.jsx'
];

for (const relPath of files) {
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;
  
  let content = fs.readFileSync(fullPath, 'utf8');
  let originalContent = content;

  // Restore c.opgId -> c._id
  content = content.replace(/c\.opgId/g, 'c._id');
  
  if (content !== originalContent) {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`Updated ${fullPath}`);
  }
}
