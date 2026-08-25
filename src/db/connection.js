'use strict';
const mongoose = require('mongoose');
const cfg            = require('../../config');
const logger         = require('../utils/logger');
const { ensureIndexes } = require('./ensureIndexes');

let connected = false;

async function connectDB() {
  if (connected) return;

  const opts = {
    dbName:                    cfg.mongo.dbName,
    maxPoolSize:               10,
    serverSelectionTimeoutMS:  5000,
    socketTimeoutMS:           45000,
    connectTimeoutMS:          10000,
  };

  try {
    await mongoose.connect(cfg.mongo.uri, opts);
    connected = true;
    logger.info(`✅ MongoDB connected → ${cfg.mongo.dbName}`);

    // Ensure all required indexes exist (idempotent)
    try {
      await ensureIndexes();
    } catch (idxErr) {
      logger.warn(`⚠️  Index creation warning (non-fatal): ${idxErr.message}`);
    }
  } catch (err) {
    logger.error('❌ MongoDB connection failed: ' + err.message);
    logger.error('👉 Fix options:');
    logger.error('   1. Local:  make sure mongod is running  →  sudo systemctl start mongod  (Linux)  /  brew services start mongodb-community  (Mac)');
    logger.error('   2. Docker: docker run -d -p 27051:27017 --name mongo mongo:7.0');
    logger.error('   3. Atlas:  set MONGODB_URI=mongodb+srv://... in .env');
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB runtime error:', err.message);
    connected = false;
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — will reconnect automatically');
    connected = false;
    setTimeout(connectDB, 5000);
  });
}

async function disconnectDB() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('MongoDB disconnected cleanly');
}

module.exports = { connectDB, disconnectDB };
