'use strict';
const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const { ok, err, validate } = require('../utils/apiUtils');
const GameResult = require('../db/gameResultModel');

// POST /api/games/results — record one finished round of a dashboard mini-game
router.post('/results',
  body('game').isString().trim().notEmpty(),
  body('mode').isIn(['solo', '2p']),
  body('pegType').optional().isIn(['color', 'number']),
  body('difficulty').isIn(['easy', 'mid', 'hard']),
  body('colorCount').isInt({ min: 2, max: 12 }),
  body('guessLimit').isInt(), // -1 means infinite
  body('won').isBoolean(),
  body('guessesUsed').isInt({ min: 1 }),
  body('timeSeconds').optional({ nullable: true }).isInt({ min: 0 }),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { game, mode, pegType = 'color', difficulty, colorCount, guessLimit, won, guessesUsed, timeSeconds } = req.body;
      const result = await GameResult.create({
        game, mode, pegType, difficulty, colorCount, guessLimit, won, guessesUsed,
        timeSeconds: timeSeconds ?? null,
      });
      ok(res, { result }, 201);
    } catch (e) { err(res, e.message); }
  }
);

// GET /api/games/:game/stats — aggregate wins/losses/best across all recorded rounds
router.get('/:game/stats',
  param('game').isString().trim().notEmpty(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { game } = req.params;
      const [wins, losses, bestAgg] = await Promise.all([
        GameResult.countDocuments({ game, won: true }),
        GameResult.countDocuments({ game, won: false }),
        GameResult.aggregate([
          { $match: { game, won: true } },
          { $group: { _id: null, best: { $min: '$guessesUsed' } } },
        ]),
      ]);
      ok(res, { wins, losses, best: bestAgg[0]?.best ?? null, totalPlayed: wins + losses });
    } catch (e) { err(res, e.message); }
  }
);

module.exports = router;
