'use strict';
const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g., 'opg_space'
  seq: { type: Number, default: 0 }
}, {
  collection: 'counters'
});

module.exports = mongoose.model('Counter', CounterSchema);
