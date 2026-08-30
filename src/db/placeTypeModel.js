'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const PlaceTypeSchema = new mongoose.Schema({
  slug:       { type: String, required: true, unique: true },
  label:      { type: String, required: true },
  googleType: String,
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, collection: cfg.collections.spacePlaceTypes, autoIndex: false });

module.exports = mongoose.model('PlaceType', PlaceTypeSchema);
