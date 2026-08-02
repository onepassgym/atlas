'use strict';
const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  slug:        { type: String, required: true, unique: true },
  key:         { type: String, unique: true },
  name:        { type: String, required: true },
  description: String,
  color:       String,
  accent:      String,
  imageUrl:    String,
  parentSlug:  { type: String, default: null },
  order:       { type: Number, default: 0 },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true, collection: 'space_categories', autoIndex: false });

module.exports = mongoose.model('Category', CategorySchema);
