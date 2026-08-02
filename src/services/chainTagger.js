'use strict';
/**
 * Chain Tagger Service
 *
 * Retroactively tags existing gyms in the database that belong to known chains.
 * Matches gyms by name patterns using chain name + aliases from the GymChain collection.
 */

const Space = require('../db/spaceModel');
const SpaceChain = require('../db/gymChainModel');
const logger   = require('../utils/logger');

/**
 * Build regex patterns from a chain's name and aliases.
 * Matches gym names that contain the chain name (case-insensitive).
 */
function buildPatterns(chain) {
  const names = [chain.name, ...(chain.aliases || [])];
  return names.map(n => {
    // Escape special regex chars
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  });
}

/**
 * Tag all existing gyms that match any known chain's name patterns.
 * @returns {Object} Summary of tagging results per chain
 */
async function tagExistingGyms() {
  const chains = await SpaceChain.find({ isActive: true }).lean();

  if (!chains.length) {
    logger.info('[ChainTagger] No active chains found. Nothing to tag.');
    return { totalTagged: 0, details: [] };
  }

  logger.info(`\n🏷️  Chain Tagger: scanning ${chains.length} chains against existing gyms...`);

  const details = [];
  let totalTagged = 0;

  for (const chain of chains) {
    const patterns = buildPatterns(chain);

    // Build $or query for all name patterns
    const orConditions = patterns.map(p => ({ name: p }));

    try {
      // Only tag gyms that aren't already tagged for this chain
      const result = await Space.updateMany(
        {
          $or: orConditions,
          $or: [
            { isChainMember: { $ne: true } },
            { chainSlug: { $ne: chain.slug } },
          ],
        },
        {
          $set: {
            chainId:       chain._id,
            chainSlug:     chain.slug,
            chainName:     chain.name,
            isChainMember: true,
          },
        }
      );

      const tagged = result.modifiedCount || 0;
      totalTagged += tagged;

      details.push({
        chainSlug: chain.slug,
        chainName: chain.name,
        patternsUsed: patterns.map(p => p.source),
        gymsTagged: tagged,
      });

      if (tagged > 0) {
        logger.info(`  🏷️  ${chain.name}: tagged ${tagged} gym(s)`);
      }
    } catch (err) {
      logger.error(`  ❌ Failed tagging for "${chain.name}": ${err.message}`);
      details.push({
        chainSlug: chain.slug,
        chainName: chain.name,
        error: err.message,
        gymsTagged: 0,
      });
    }
  }

  // Update chain stats after tagging
  for (const chain of chains) {
    try {
      const count = await Space.countDocuments({ chainSlug: chain.slug, isChainMember: true });
      const countries = await Space.distinct('addressParts.country', { chainSlug: chain.slug, isChainMember: true });

      await SpaceChain.findByIdAndUpdate(chain._id, {
        $set: {
          totalLocations: count,
          countriesPresent: countries.filter(Boolean),
        },
      });
    } catch (_) {}
  }

  logger.info(`\n🏷️  Chain Tagger complete: ${totalTagged} gyms tagged across ${chains.length} chains\n`);

  return { totalTagged, details };
}

/**
 * Tag gyms for a specific chain only.
 * @param {string} chainSlug - The slug of the chain to tag for
 */
async function tagChain(chainSlug) {
  const chain = await SpaceChain.findOne({ slug: chainSlug }).lean();
  if (!chain) {
    throw new Error(`Chain not found: ${chainSlug}`);
  }

  const patterns = buildPatterns(chain);
  const orConditions = patterns.map(p => ({ name: p }));

  const result = await Space.updateMany(
    {
      $or: orConditions,
      chainSlug: { $ne: chain.slug },
    },
    {
      $set: {
        chainId:       chain._id,
        chainSlug:     chain.slug,
        chainName:     chain.name,
        isChainMember: true,
      },
    }
  );

  const tagged = result.modifiedCount || 0;

  // Update chain stats
  const count = await Space.countDocuments({ chainSlug: chain.slug, isChainMember: true });
  await SpaceChain.findByIdAndUpdate(chain._id, {
    $set: { totalLocations: count },
  });

  logger.info(`🏷️  Tagged ${tagged} gyms for chain: ${chain.name}`);
  return { chainSlug: chain.slug, chainName: chain.name, gymsTagged: tagged, totalInChain: count };
}

module.exports = { tagExistingGyms, tagChain };
