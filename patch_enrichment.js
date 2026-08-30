const fs = require('fs');
const path = require('path');

const file = path.resolve(process.cwd(), 'src/api/enrichmentRoutes.js');
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  "body('spaceId').notEmpty().isMongoId(),",
  "body('spaceId').notEmpty().matches(/^(OPG-[A-Z]+-[A-Z0-9]+|[a-fA-F0-9]{24})$/),"
);

content = content.replace(
  "body('spaceIds.*').isMongoId(),",
  "body('spaceIds.*').matches(/^(OPG-[A-Z]+-[A-Z0-9]+|[a-fA-F0-9]{24})$/),"
);

content = content.replace(
  "param('spaceId').isMongoId(),",
  "param('spaceId').matches(/^(OPG-[A-Z]+-[A-Z0-9]+|[a-fA-F0-9]{24})$/),"
);

// We need to resolve opgId to _id in the routes.
content = content.replace(
  "const space = await Space.findById(spaceId).select('name areaName googleMapsUrl').lean();",
  "const isMongoId = /^[a-fA-F0-9]{24}$/.test(spaceId);\n      const space = isMongoId ? await Space.findById(spaceId).select('_id name areaName googleMapsUrl').lean() : await Space.findOne({ opgId: spaceId }).select('_id name areaName googleMapsUrl').lean();"
);
content = content.replace(
  "await pushPrioritySpace(spaceId, space.name, sections);",
  "await pushPrioritySpace(space._id.toString(), space.name, sections);"
);

// In `/priority/batch`:
content = content.replace(
  "_id: { $in: spaceIds },",
  "$or: [{ _id: { $in: spaceIds.filter(id => /^[a-fA-F0-9]{24}$/.test(id)) } }, { opgId: { $in: spaceIds.filter(id => /^OPG-/.test(id)) } }],"
);

// In `/logs/:spaceId`:
content = content.replace(
  "const logs = await EnrichmentLog.find({ spaceId })",
  "const isMongoId = /^[a-fA-F0-9]{24}$/.test(spaceId);\n      const space = isMongoId ? { _id: spaceId } : await Space.findOne({ opgId: spaceId }).select('_id').lean();\n      const logs = await EnrichmentLog.find({ spaceId: space ? space._id : spaceId })"
);

fs.writeFileSync(file, content, 'utf8');
console.log("Updated enrichmentRoutes.js");
