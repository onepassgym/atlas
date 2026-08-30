require('dotenv').config();
const mongoose = require('mongoose');
const cfg = require('./config');
const Space = require('./src/db/spaceModel');

async function test() {
  await mongoose.connect(cfg.mongo.uri);
  console.log("Connected to", cfg.mongo.uri);
  console.log("Space collection name:", Space.collection.name);
  const count = await Space.countDocuments();
  console.log("Count:", count);
  process.exit(0);
}
test();
