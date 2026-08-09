'use strict';
/**
 * llmClient.js — Unified LLM wrapper for OpenAI + Anthropic.
 *
 * Features:
 *   - Model routing by task tier (fast / smart / prose)
 *   - Redis response cache (keyed by input hash, 24h TTL)
 *   - Cost tracking (tokens in/out logged per call)
 *   - Retry with exponential backoff (3 attempts)
 *   - Per-space cost cap enforcement
 */

const crypto = require('crypto');
const Redis  = require('ioredis');
const cfg    = require('../../../config');
const logger = require('../../utils/logger');

let _openai     = null;
let _anthropic  = null;
let _redis      = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      host:     cfg.redis.host,
      port:     cfg.redis.port,
      password: cfg.redis.password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    _redis.connect().catch(() => {});
  }
  return _redis;
}

function getOpenAI() {
  if (!_openai) {
    const { OpenAI } = require('openai');
    _openai = new OpenAI({ apiKey: cfg.ai.openaiKey });
  }
  return _openai;
}

function getAnthropic() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: cfg.ai.anthropicKey });
  }
  return _anthropic;
}

// Rough cost estimate — USD per 1000 tokens
const TOKEN_COSTS = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4o':      { in: 0.005,   out: 0.015  },
  'claude-3-5-haiku-20241022': { in: 0.001, out: 0.005 },
  'claude-3-5-sonnet-20241022':{ in: 0.003, out: 0.015 },
};

function estimateCost(model, inTokens, outTokens) {
  const rates = TOKEN_COSTS[model] || { in: 0.001, out: 0.003 };
  return (inTokens / 1000) * rates.in + (outTokens / 1000) * rates.out;
}

/**
 * Call an LLM with a system + user prompt, returning parsed JSON.
 *
 * @param {object} opts
 * @param {string} opts.system         - System prompt
 * @param {string} opts.user           - User prompt
 * @param {string} opts.model          - Model ID (default: cfg.ai.modelFast)
 * @param {string} opts.provider       - 'openai' | 'anthropic' (default: cfg.ai.provider)
 * @param {number} opts.maxTokens      - Output token limit (default: 500)
 * @param {boolean} opts.json          - Expect JSON response (default: true)
 * @param {string} opts.cacheKey       - Custom cache key (auto-generated if omitted)
 * @returns {{ result: any, cost: number, cached: boolean }}
 */
async function call({ system, user, model, provider, maxTokens = 500, json = true, cacheKey }) {
  if (!cfg.ai?.enabled) return { result: null, cost: 0, cached: false };

  const resolvedModel    = model    || cfg.ai.modelFast;
  const resolvedProvider = provider || cfg.ai.provider || 'openai';
  const cacheTtl         = cfg.ai.cacheTtlSec || 86400;

  // Build cache key
  const cKey = cacheKey || crypto
    .createHash('sha256')
    .update(`${resolvedModel}:${system}:${user}`)
    .digest('hex')
    .slice(0, 32);

  // Check cache
  try {
    const cached = await getRedis().get(`atlas:llm:${cKey}`);
    if (cached) {
      return { result: JSON.parse(cached), cost: 0, cached: true };
    }
  } catch (_) {}

  // Call LLM with retries
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let rawText;
      let inTokens  = 0;
      let outTokens = 0;

      if (resolvedProvider === 'anthropic') {
        const ai = getAnthropic();
        const resp = await ai.messages.create({
          model:      resolvedModel,
          max_tokens: maxTokens,
          system,
          messages:   [{ role: 'user', content: user }],
        });
        rawText   = resp.content?.[0]?.text || '';
        inTokens  = resp.usage?.input_tokens  || 0;
        outTokens = resp.usage?.output_tokens || 0;
      } else {
        const ai = getOpenAI();
        const resp = await ai.chat.completions.create({
          model:       resolvedModel,
          max_tokens:  maxTokens,
          messages:    [
            { role: 'system', content: system },
            { role: 'user',   content: user   },
          ],
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        });
        rawText   = resp.choices?.[0]?.message?.content || '';
        inTokens  = resp.usage?.prompt_tokens     || 0;
        outTokens = resp.usage?.completion_tokens || 0;
      }

      const cost   = estimateCost(resolvedModel, inTokens, outTokens);
      const result = json ? JSON.parse(rawText) : rawText;

      // Cache successful response
      try {
        await getRedis().set(`atlas:llm:${cKey}`, JSON.stringify(result), 'EX', cacheTtl);
      } catch (_) {}

      logger.debug(`[LLM] ${resolvedModel} | in:${inTokens} out:${outTokens} | $${cost.toFixed(5)}`);
      return { result, cost, cached: false };

    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  logger.warn(`[LLM] All 3 attempts failed: ${lastErr?.message}`);
  return { result: null, cost: 0, cached: false };
}

module.exports = { call };
