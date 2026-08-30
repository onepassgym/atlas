'use strict';
const mongoose = require('mongoose');

const SystemStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g., 'command_center'
  
  // System Flags
  globalPause: { type: Boolean, default: false }, // Pauses all queues
  crawlPace: { type: String, enum: ['slow', 'normal', 'fast'], default: 'normal' }, // Defines concurrency/delay
  
  mediaQueuePaused: { type: Boolean, default: false },
  crawlQueuePaused: { type: Boolean, default: false },
  maintenanceMode: { type: Boolean, default: false },
  dashboardPin: { type: String, default: '0000' },
  
  // Additional metrics or states can be added here
  lastUpdatedBy: { type: String, default: 'system' }
}, { 
  timestamps: true,
  collection: 'system_states',
  autoIndex: false,
});

// Helper to get or create the singleton state document
SystemStateSchema.statics.getGlobalState = async function() {
  let state = await this.findOne({ key: 'command_center' });
  if (!state) {
    state = await this.create({ key: 'command_center' });
  }
  return state;
};

module.exports = mongoose.model('SystemState', SystemStateSchema);
