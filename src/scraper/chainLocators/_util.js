'use strict';

/**
 * Shared helpers for chain locator modules.
 *
 * Every dedicated locator sweeps a set of regions/cities against a public
 * store-locator API. Those endpoints break silently — DNS change, 403, WAF,
 * empty JSON — and the old locators returned `[]` on total failure, which the
 * chain worker then treated as a successful "no locations to crawl" run.
 *
 * `assertLocatorRunSucceeded` distinguishes:
 *   - Every attempt threw           → API is broken, throw so the chain worker
 *                                     records the job as failed.
 *   - Some attempts succeeded but
 *     nothing was returned          → legitimate zero-coverage; return [].
 *   - Anything else                 → normal.
 */

function assertLocatorRunSucceeded({ label, attempted, failed, found }) {
  if (attempted > 0 && attempted === failed) {
    throw new Error(
      `[${label}] All ${attempted} store-locator requests failed — endpoint is unreachable or has changed. ` +
      `Refusing to report zero locations as success.`,
    );
  }
  if (attempted > 0 && failed > 0 && found === 0) {
    throw new Error(
      `[${label}] ${failed}/${attempted} store-locator requests failed and 0 locations were returned. ` +
      `Treating as a locator failure.`,
    );
  }
}

module.exports = { assertLocatorRunSucceeded };
