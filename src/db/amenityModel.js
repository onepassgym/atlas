'use strict';
const mongoose = require('mongoose');

const AmenitySchema = new mongoose.Schema({
  slug:     { type: String, required: true, unique: true },
  key:      { type: String, unique: true },
  name:     { type: String, required: true },
  category: { type: String, enum: ['equipment', 'facility', 'service', 'wellness', null] },
  icon:     String,
  isActive: { type: Boolean, default: true },
}, { timestamps: true, collection: 'space_amenities', autoIndex: false });

module.exports = mongoose.model('Amenity', AmenitySchema);
