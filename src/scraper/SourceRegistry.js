'use strict';
/**
 * SourceRegistry — singleton that manages all scraper source adapters.
 *
 * Responsibilities:
 *   - Route scrapeByUrl() to the correct adapter via canHandleUrl()
 *   - Fan-out searchByName() / searchByArea() to all enabled adapters in parallel
 *   - Apply per-source concurrency limits and timeouts
 *   - Track per-source health (success/error counts)
 */

const logger = require('../utils/logger');

// All available source adapters
const SOURCES = [
  require('./sources/GoogleMapsSource'),
  require('./sources/JustDialSource'),
  require('./sources/OSMSource'),
  require('./sources/YelpSource'),
  require('./sources/OfficialWebsiteSource'),
];

// Max parallel source fan-outs for search operations
const MAX_PARALLEL_SOURCES = parseInt(process.env.SOURCE_SEARCH_PARALLEL || '3', 10);
// Timeout per source (ms)
const SOURCE_TIMEOUT_MS = parseInt(process.env.SOURCE_TIMEOUT_MS || '60000', 10);

class SourceRegistry {
  constructor() {
    this._sources  = SOURCES;
    this._health   = {}; // sourceId → { success, error, lastUsedAt }
    this._disabled = new Set(
      (process.env.DISABLED_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean)
    );
  }

  get activeSources() {
    return this._sources.filter(s => !this._disabled.has(s.sourceId));
  }

  // ── URL-based routing ────────────────────────────────────────────────────

  /**
   * Find the best adapter for a given URL and scrape it.
   * Falls back to OfficialWebsiteSource for unrecognized URLs.
   */
  async scrapeByUrl(url) {
    if (!url) return null;

    const source = this.activeSources.find(s => s.canHandleUrl(url))
      || this.activeSources.find(s => s.sourceId === 'official_website');

    if (!source) {
      logger.warn(`[SourceRegistry] No adapter for URL: ${url}`);
      return null;
    }

    logger.info(`[SourceRegistry] scrapeByUrl via ${source.sourceId}: ${url}`);
    try {
      const result = await this._withTimeout(source.scrapeByUrl(url), SOURCE_TIMEOUT_MS);
      this._trackHealth(source.sourceId, true);
      return result;
    } catch (err) {
      this._trackHealth(source.sourceId, false);
      logger.error(`[SourceRegistry] ${source.sourceId} scrapeByUrl failed: ${err.message}`);
      return null;
    }
  }

  // ── Name-based fan-out ───────────────────────────────────────────────────

  /**
   * Search for a fitness space by name across all active sources (with concurrency cap).
   * Returns array of RawSpaceResult from all sources combined.
   */
  async searchByName(name, location = null, categories = []) {
    logger.info(`[SourceRegistry] searchByName: "${name}" location="${location || ''}"`);
    const results = await this._fanOut(
      s => s.searchByName(name, location, categories),
      // OfficialWebsite can't do name search — skip it
      this.activeSources.filter(s => s.sourceId !== 'official_website')
    );
    return results;
  }

  // ── Area-based fan-out ───────────────────────────────────────────────────

  /**
   * Search all fitness spaces in an area across active sources.
   */
  async searchByArea(area, categories = []) {
    logger.info(`[SourceRegistry] searchByArea: "${area}"`);
    const results = await this._fanOut(
      s => s.searchByArea(area, categories),
      this.activeSources.filter(s => s.sourceId !== 'official_website')
    );
    return results;
  }

  // ── Enrichment ───────────────────────────────────────────────────────────

  /**
   * Enrich a space from a specific source (used during enrichment pipeline stages).
   */
  async enrichFromSource(sourceId, space, stages = ['all']) {
    const source = this.activeSources.find(s => s.sourceId === sourceId);
    if (!source) return {};

    try {
      return await this._withTimeout(source.enrichSpace(space, stages), SOURCE_TIMEOUT_MS);
    } catch (err) {
      logger.warn(`[SourceRegistry] enrich from ${sourceId} failed: ${err.message}`);
      return {};
    }
  }

  // ── Health reporting ─────────────────────────────────────────────────────

  getHealth() {
    return this._sources.map(s => ({
      sourceId:  s.sourceId,
      enabled:   !this._disabled.has(s.sourceId),
      ...(this._health[s.sourceId] || { success: 0, error: 0, lastUsedAt: null }),
    }));
  }

  disableSource(sourceId) { this._disabled.add(sourceId); }
  enableSource(sourceId)  { this._disabled.delete(sourceId); }

  // ── Internals ────────────────────────────────────────────────────────────

  async _fanOut(fn, sources) {
    const batches = [];
    for (let i = 0; i < sources.length; i += MAX_PARALLEL_SOURCES) {
      batches.push(sources.slice(i, i + MAX_PARALLEL_SOURCES));
    }

    const allResults = [];
    for (const batch of batches) {
      const settled = await Promise.allSettled(
        batch.map(s => this._withTimeout(fn(s), SOURCE_TIMEOUT_MS).then(
          results => { this._trackHealth(s.sourceId, true); return results; },
          err     => { this._trackHealth(s.sourceId, false); logger.warn(`[SourceRegistry] ${s.sourceId}: ${err.message}`); return []; }
        ))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') allResults.push(...(r.value || []));
      }
    }
    return allResults;
  }

  _withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Source timeout')), ms)),
    ]);
  }

  _trackHealth(sourceId, success) {
    if (!this._health[sourceId]) this._health[sourceId] = { success: 0, error: 0, lastUsedAt: null };
    if (success) this._health[sourceId].success++;
    else         this._health[sourceId].error++;
    this._health[sourceId].lastUsedAt = new Date().toISOString();
  }
}

module.exports = new SourceRegistry();
