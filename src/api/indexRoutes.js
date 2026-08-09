'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const cfg = require('../../config');

// Base properties to avoid reading config again if not needed
const SERVER_PORT = cfg.server?.port || process.env.PORT || 3000;

// Health check
router.get('/health', (_, res) => res.json({
  status:  'ok',
  service: 'Atlas Scraper',
  version: '1.0.0',
  uptime:  process.uptime(),
  ts:      new Date(),
  port:    SERVER_PORT,
}));

module.exports = router;
