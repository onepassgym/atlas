'use strict';
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════════
// opgId v5 — Format: {ENTITY}-{WORD}-{base32tail}
//
// ENTITY:  3-letter load-bearing prefix (SPC, RVW, PHT, CHN, LOC)
// WORD:    4-7 letter cosmetic animal/bird (ignored for uniqueness)
// base32:  13-14 chars (~70 bits) for high-volume atlas tables
//
// Generated app-side, zero DB round-trip. opgId is unique-indexed; _id stays ObjectId.
// ═══════════════════════════════════════════════════════════════════════════════

const ANIMALS = [
  'TIGER','EAGLE','WOLF','BEAR','LION','HAWK','LYNX','COBRA',
  'CRANE','RAVEN','BISON','PUMA','FALCON','CONDOR','JAGUAR',
  'PANTHER','OSPREY','KESTREL','MERLIN','DINGO','RHINO','MAMBA',
  'KODIAK','RAPTOR','HERON','OTTER','BADGER','VIPER','MOOSE',
  'DRAKE','SABLE','PYTHON','CHEETAH','BRONCO','MUSTANG',
];

// Crockford base32 alphabet (no I, L, O, U to avoid ambiguity)
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Entity prefix registry for atlas cluster
const ENTITY_PREFIXES = {
  space:       'SPC',
  review:      'RVW',
  photo:       'PHT',
  chain:       'CHN',
  location:    'LOC',
  needsReview: 'NRV',
  seed:        'SED',
};

/**
 * Generate a v5 opgId.
 * @param {string} entity - One of: space, review, photo, chain, location
 * @param {{ highVolume?: boolean }} opts - highVolume=true → 14 char tail (~70 bits)
 * @returns {string} e.g. "SPC-TIGER-9QX4M3PA7KF2QH"
 */
function makeOpgId(entity, { highVolume = true } = {}) {
  const prefix = ENTITY_PREFIXES[entity];
  if (!prefix) throw new Error(`Unknown entity "${entity}". Valid: ${Object.keys(ENTITY_PREFIXES).join(', ')}`);

  const word = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const tailLen = highVolume ? 14 : 11;
  const bytes = crypto.randomBytes(tailLen);
  let tail = '';
  for (let i = 0; i < tailLen; i++) {
    tail += BASE32[bytes[i] % 32];
  }

  return `${prefix}-${word}-${tail}`;
}

/**
 * Validate a v5 opgId format.
 * @param {string} str
 * @returns {boolean}
 */
function isValidOpgId(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[A-Z]{3}-[A-Z]{4,7}-[0-9A-Z]{11,14}$/.test(str);
}

/**
 * Validate a legacy OPG-KEYWORD-XXXX format (for migration).
 * @param {string} str
 * @returns {boolean}
 */
function isLegacyOpgId(str) {
  return /^OPG-[A-Z]+-[A-Z2-9]{4}$/.test(str);
}

/**
 * Extract the entity type from an opgId prefix.
 * @param {string} opgId
 * @returns {string|null} e.g. 'space', 'review', etc.
 */
function entityFromOpgId(opgId) {
  if (!opgId) return null;
  const prefix = opgId.split('-')[0];
  return Object.entries(ENTITY_PREFIXES).find(([, v]) => v === prefix)?.[0] || null;
}

module.exports = { makeOpgId, isValidOpgId, isLegacyOpgId, entityFromOpgId, ENTITY_PREFIXES };
