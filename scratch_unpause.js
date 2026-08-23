const { connectDB } = require('./src/db/connection');
const SystemState = require('./src/db/systemStateModel');
const mongoose = require('mongoose');

async function run() {
  await connectDB();
  const state = await SystemState.findOneAndUpdate(
    { key: 'command_center' },
    { globalPause: false, crawlQueuePaused: false, mediaQueuePaused: false },
    { new: true }
  );
  console.log("Updated state:", state);
  await mongoose.disconnect();
  process.exit(0);
}
run().catch(err => {
  console.error(err);
  process.exit(1);
});
