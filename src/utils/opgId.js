'use strict';
const Counter = require('../db/counterModel');

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
 * Reserve a block of IDs atomically.
 * @param {string} entity - One of: space, review, photo, chain, location
 * @param {number} count - Number of IDs to reserve
 * @returns {Promise<number>} - The starting sequence number
 */
async function reserveOpgIds(entity, count = 1) {
  const prefix = ENTITY_PREFIXES[entity];
  if (!prefix) throw new Error(`Unknown entity "${entity}". Valid: ${Object.keys(ENTITY_PREFIXES).join(', ')}`);

  const counter = await Counter.findByIdAndUpdate(
    `opg_${entity}`,
    { $inc: { seq: count } },
    { new: true, upsert: true }
  );
  
  // If we incremented by `count`, the start of our reserved block is `counter.seq - count`
  return counter.seq - count;
}

/**
 * Generate a v5 opgId synchronously from a sequence number.
 * Format: {PREFIX}-{ANIMAL}-{4_CHAR_BASE32}
 * @param {string} entity - One of: space, review, photo, chain, location
 * @param {number} seq - Sequence integer from reserveOpgIds
 * @returns {string} e.g. "SPC-TIGER-465Q"
 */
function generateOpgId(entity, seq) {
  const prefix = ENTITY_PREFIXES[entity];
  if (!prefix) throw new Error(`Unknown entity "${entity}". Valid: ${Object.keys(ENTITY_PREFIXES).join(', ')}`);

  // Max 4-char Base32 = 32^4 = 1,048,576
  const MAX_BASE32_VAL = 1048576; 
  
  // Use seq to deterministically pick an animal, rollover if seq > max Base32
  const animalIndex = Math.floor(seq / MAX_BASE32_VAL) % ANIMALS.length;
  const word = ANIMALS[animalIndex];
  
  // Get remainder for the 4-char base32 tail
  let remainder = seq % MAX_BASE32_VAL;
  let tail = '';
  for (let i = 0; i < 4; i++) {
    tail = BASE32[remainder % 32] + tail;
    remainder = Math.floor(remainder / 32);
  }

  return `${prefix}-${word}-${tail}`;
}

/**
 * Convenience wrapper for generating a single ID.
 * @param {string} entity - One of: space, review, photo, chain, location
 * @returns {Promise<string>} e.g. "SPC-TIGER-465Q"
 */
async function generateSingleOpgId(entity) {
  const seq = await reserveOpgIds(entity, 1);
  return generateOpgId(entity, seq);
}

/**
 * Validate a v5 opgId format.
 * @param {string} str
 * @returns {boolean}
 */
function isValidOpgId(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[A-Z]{3}-[A-Z]{4,7}-[0-9A-Z]{4,14}$/.test(str);
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

module.exports = { reserveOpgIds, generateOpgId, generateSingleOpgId, isValidOpgId, isLegacyOpgId, entityFromOpgId, ENTITY_PREFIXES };
