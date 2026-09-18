'use strict';

/**
 * Races a promise against a timeout, rejecting with a tagged error if the
 * promise doesn't settle in time. Used to bound operations (e.g. browser
 * launch) that have no reliable native timeout of their own, so a single
 * hang can't block a worker slot forever.
 */
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.code = 'TIMEOUT';
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout };
