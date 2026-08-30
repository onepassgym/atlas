const fs = require('fs');
const path = require('path');

const files = [
  'src/api/spaceRoutes.js',
  'src/api/enrichmentRoutes.js'
];

for (const relPath of files) {
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;
  
  let content = fs.readFileSync(fullPath, 'utf8');
  let originalContent = content;

  // Replace old regexes with a permissive one: OPG-[A-Z]+-[A-Z0-9]+ or MongoId
  content = content.replace(/OPG-\[A-Z\]\+-\[A-Z2-9\]\{4\}/g, 'OPG-[A-Z]+-[A-Z0-9]+');
  
  if (content !== originalContent) {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`Updated ${fullPath}`);
  }
}
