'use strict';
const mongoose = require('mongoose');
const cfg = require('../../config');

const AmenitySchema = new mongoose.Schema({
  slug:  { type: String, required: true, unique: true },
  label: { type: String, required: true },
  icon:  String,
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, collection: cfg.collections.spaceAmenities, autoIndex: false });

module.exports = mongoose.model('Amenity', AmenitySchema);
