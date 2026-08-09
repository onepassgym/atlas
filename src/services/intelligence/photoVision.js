'use strict';
const sharp = require('sharp');

/**
 * Analyzes an image buffer using sharp to determine basic visual characteristics.
 * Returns visual appeal score, detected tags, and quality flags.
 */
async function analyzePhotoBuffer(buffer) {
  try {
    const stats = await sharp(buffer).stats();
    // stats.channels is an array of objects { min, max, sum, squaresSum, mean, stdev, minX, minY, maxX, maxY }
    // typically channels 0=R, 1=G, 2=B
    
    // Average mean across RGB (rough perceived brightness)
    const rMean = stats.channels[0]?.mean || 0;
    const gMean = stats.channels[1]?.mean || 0;
    const bMean = stats.channels[2]?.mean || 0;
    const brightness = (rMean * 0.299) + (gMean * 0.587) + (bMean * 0.114);

    // Average standard deviation (rough proxy for contrast and detail)
    const rStdev = stats.channels[0]?.stdev || 0;
    const gStdev = stats.channels[1]?.stdev || 0;
    const bStdev = stats.channels[2]?.stdev || 0;
    const contrast = (rStdev + gStdev + bStdev) / 3;

    const tags = [];
    let appealScore = 70; // base score
    
    // 1. Check brightness
    if (brightness < 40) {
      tags.push('dark');
      appealScore -= 20;
    } else if (brightness > 220) {
      tags.push('overexposed');
      appealScore -= 15;
    } else if (brightness >= 90 && brightness <= 180) {
      appealScore += 10; // well lit
    }

    // 2. Check contrast/sharpness
    if (contrast < 25) {
      tags.push('blurry_or_low_contrast');
      appealScore -= 25;
    } else if (contrast > 60) {
      tags.push('high_contrast');
      appealScore += 10; // good contrast
    }

    // 3. Simple color heuristics for basic tagging (simulated ML)
    if (bMean > rMean * 1.3 && bMean > gMean * 1.2 && brightness > 70) {
      tags.push('pool_or_exterior'); // High blue content
    } else if (gMean > rMean * 1.1 && gMean > bMean * 1.1) {
      tags.push('outdoor_greenery');
    } else if (rMean > 100 && gMean < 100 && bMean < 100) {
      tags.push('equipment'); // Warm tones, often gym mats/equipment
    } else if (brightness > 180 && contrast < 40) {
      tags.push('document_or_flyer'); // bright but low color variance
      appealScore -= 30; // flyers make bad cover photos
    } else {
      tags.push('interior');
    }

    // Cap score 0-100
    appealScore = Math.max(0, Math.min(100, Math.round(appealScore)));

    return {
      appealScore,
      brightness: Math.round(brightness),
      contrast: Math.round(contrast),
      tags
    };
  } catch (err) {
    return { appealScore: 50, brightness: 0, contrast: 0, tags: ['unanalyzable'] };
  }
}

/**
 * Downloads an image from a URL and runs analyzePhotoBuffer on it.
 * Returns { score, tags } — the format expected by Stage 5 enrichment.
 */
async function analyzePhotoAppeal(url) {
  try {
    const axios = require('axios');
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 Atlas-Media-Analyzer/1.0' },
      maxContentLength: 15 * 1024 * 1024,
    });
    const buffer = Buffer.from(resp.data);
    const { appealScore, tags } = await analyzePhotoBuffer(buffer);
    return { score: appealScore, tags };
  } catch (_) {
    return { score: 50, tags: ['download_error'] };
  }
}

module.exports = { analyzePhotoBuffer, analyzePhotoAppeal };
