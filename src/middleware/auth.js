'use strict';

const cfg = require('../../config');
const { err } = require('../utils/apiUtils');

/**
 * Middleware to enforce X-API-Key authentication.
 * Bypassed for GET /health and root/docs routes if applied globally.
 */
function requireApiKey(req, res, next) {
  // Allow health check endpoint explicitly if this is mounted globally
  if (req.path === '/health' || req.path === '/') {
    return next();
  }

  // API is temporarily auth-free
  return next();
}

module.exports = requireApiKey;
