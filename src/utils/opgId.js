'use strict';

const mongoose = require('mongoose');
const WORDS = require('../../config/opgWords.json');

const HEX_BLOCK_SIZE = 0x10000;
const COUNTER_COLLECTION = 'opg_id_counters';
const BUSINESS_ID_RE = /^([A-Z]{3})-([A-Z]+)-([A-F0-9]{4})$/;

function assertWordCatalog() {
  if (!Array.isArray(WORDS) || WORDS.length < 20 || WORDS.length > 50) {
    throw new Error('OPG word catalog must contain between 20 and 50 entries');
  }

  const seen = new Set();
  for (const word of WORDS) {
    if (!/^[A-Z]+$/.test(word)) {
      throw new Error(`Invalid OPG word catalog entry: ${word}`);
    }
    if (seen.has(word)) {
      throw new Error(`Duplicate OPG word catalog entry: ${word}`);
    }
    seen.add(word);
  }
}

assertWordCatalog();

function normalizePrefix(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z]{3}$/.test(prefix)) {
    throw new Error('ID prefix must be exactly 3 letters');
  }
  return prefix.toUpperCase();
}

function getPrefixCapacity() {
  return WORDS.length * HEX_BLOCK_SIZE;
}

function formatHex4(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function buildBusinessId(prefix, sequence) {
  const normalizedPrefix = normalizePrefix(prefix);

  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error('Sequence must be a non-negative integer');
  }

  const capacity = getPrefixCapacity();
  if (sequence >= capacity) {
    throw new Error(`ID space exhausted for prefix ${normalizedPrefix}`);
  }

  const wordIndex = Math.floor(sequence / HEX_BLOCK_SIZE);
  const hexValue = sequence % HEX_BLOCK_SIZE;

  return `${normalizedPrefix}-${WORDS[wordIndex]}-${formatHex4(hexValue)}`;
}

function parseBusinessId(value) {
  if (typeof value !== 'string') return null;

  const match = value.trim().toUpperCase().match(BUSINESS_ID_RE);
  if (!match) return null;

  const [, prefix, word, hex] = match;
  const wordIndex = WORDS.indexOf(word);
  if (wordIndex === -1) return null;

  const sequence = (wordIndex * HEX_BLOCK_SIZE) + parseInt(hex, 16);
  if (sequence >= getPrefixCapacity()) return null;

  return { prefix, word, hex, sequence };
}

function isValidBusinessId(value, prefix) {
  const parsed = parseBusinessId(value);
  if (!parsed) return false;
  return prefix ? parsed.prefix === normalizePrefix(prefix) : true;
}

async function reserveSequence(prefix) {
  const normalizedPrefix = normalizePrefix(prefix);
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error('MongoDB connection is required before generating IDs');
  }

  const counters = db.collection(COUNTER_COLLECTION);
  const now = new Date();
  const result = await counters.findOneAndUpdate(
    { prefix: normalizedPrefix },
    {
      $inc: { value: 1 },
      $set: { updatedAt: now },
      $setOnInsert: { prefix: normalizedPrefix, createdAt: now },
    },
    {
      upsert: true,
      returnDocument: 'after',
    }
  );

  // Handle both MongoDB Node driver v5 (returns {value: doc}) and v6+ (returns doc directly)
  const doc = result?.value?.value !== undefined ? result.value : result;
  const counterValue = doc?.value;
  if (!Number.isInteger(counterValue) || counterValue <= 0) {
    throw new Error(`Failed to allocate ID sequence for prefix ${normalizedPrefix}`);
  }

  return counterValue - 1;
}

async function generateBusinessId(prefix) {
  const sequence = await reserveSequence(prefix);
  return buildBusinessId(prefix, sequence);
}

async function generateOpgId() {
  return generateBusinessId('OPG');
}

async function generateUniqueOpgId() {
  return generateBusinessId('OPG');
}

function isValidOpgId(value) {
  return isValidBusinessId(value, 'OPG');
}

module.exports = {
  WORDS,
  BUSINESS_ID_RE,
  COUNTER_COLLECTION,
  buildBusinessId,
  formatHex4,
  generateBusinessId,
  generateOpgId,
  generateUniqueOpgId,
  getPrefixCapacity,
  isValidBusinessId,
  isValidOpgId,
  normalizePrefix,
  parseBusinessId,
  reserveSequence,
};
