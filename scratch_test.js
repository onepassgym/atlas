const { connectDB } = require('./src/db/connection');
const SystemState = require('./src/db/systemStateModel');
const mongoose = require('mongoose');

async function run() {
  await connectDB();
  const state = await SystemState.getGlobalState();
  console.log("State:", state);
  await mongoose.disconnect();
}
run().catch(console.error);
