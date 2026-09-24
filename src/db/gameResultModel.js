'use strict';
const mongoose = require('mongoose');

// Finished rounds for dashboard mini-games (e.g. the Simulations page's
// Mastermind/Codebreak module) — powers the WINS/BEST/LOSSES stats shown
// in-game so they persist across browsers/devices instead of living only
// in localStorage.
const GameResultSchema = new mongoose.Schema({
  game:        { type: String, required: true, index: true }, // e.g. 'mastermind'
  mode:        { type: String, enum: ['solo', '2p'], required: true },
  pegType:     { type: String, enum: ['color', 'number'], default: 'color' },
  difficulty:  { type: String, enum: ['easy', 'mid', 'hard'], required: true },
  colorCount:  { type: Number, required: true },
  // -1 marks an infinite-guess round — Mongo has no Infinity for a Number.
  guessLimit:  { type: Number, required: true },
  won:         { type: Boolean, required: true },
  guessesUsed: { type: Number, required: true },
  timeSeconds: { type: Number, default: null },
}, {
  timestamps: true,
  collection: 'game_results',
  autoIndex: false,
});

GameResultSchema.index({ game: 1, createdAt: -1 });
GameResultSchema.index({ game: 1, won: 1 });

module.exports = mongoose.model('GameResult', GameResultSchema);
