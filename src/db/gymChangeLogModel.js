'use strict';
const mongoose = require('mongoose');

const ChangeLogSchema = new mongoose.Schema(
  {
    spaceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true },
    spaceOpgId: { type: String, index: true, trim: true },
    field:      { type: String, required: true },
    oldValue:   mongoose.Schema.Types.Mixed,
    newValue:   mongoose.Schema.Types.Mixed,
    changedAt:  { type: Date, default: () => new Date() },
    source:     { type: String, default: 'crawler' },
  },
  {
    timestamps: false,
    collection: 'space_change_logs',
    autoIndex: false,
  }
);

ChangeLogSchema.index({ spaceId: 1 });
ChangeLogSchema.index({ spaceOpgId: 1 });
ChangeLogSchema.index({ changedAt: -1 });

module.exports = mongoose.model('ChangeLog', ChangeLogSchema);
