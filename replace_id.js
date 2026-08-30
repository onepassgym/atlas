const fs = require('fs');
const path = require('path');

const dirs = ['dashboard/src/components', 'dashboard/src/pages'];

function processDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.jsx')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let originalContent = content;
      
      // Specifically target variables named 'space' or 'g' or 'c' which might have _id
      content = content.replace(/space\._id/g, 'space.opgId');
      content = content.replace(/g\._id/g, 'g.opgId');
      content = content.replace(/c\._id/g, 'c.opgId');
      content = content.replace(/log\._id/g, 'log.opgId');

      if (content !== originalContent) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`Updated ${fullPath}`);
      }
    }
  }
}

for (const dir of dirs) {
  processDir(path.resolve(process.cwd(), dir));
}
