'use strict';

const POSITIVE_KEYWORDS = [
  'clean', 'spacious', 'friendly', 'great', 'excellent', 'awesome', 'good',
  'best', 'recommend', 'love', 'helpful', 'knowledgeable', 'maintained', 
  'hygienic', 'amazing', 'perfect', 'professional', 'hygiene', 'equipped',
  'modern', 'supportive', 'safe'
];

const NEGATIVE_KEYWORDS = [
  'dirty', 'crowded', 'rude', 'expensive', 'broken', 'bad', 'worst',
  'terrible', 'unprofessional', 'smelly', 'stuffy', 'small', 'congested', 
  'overpriced', 'scam', 'poor', 'unhygienic', 'old', 'rusted', 'cramped',
  'arrogant'
];

/**
 * Analyzes a single string of text and returns a sentiment score from -1.0 to +1.0.
 * @param {string} text 
 * @returns {number}
 */
function analyzeTextSentiment(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let posCount = 0;
  let negCount = 0;

  for (const word of POSITIVE_KEYWORDS) {
    if (lower.includes(word)) posCount++;
  }
  for (const word of NEGATIVE_KEYWORDS) {
    if (lower.includes(word)) negCount++;
  }

  const total = posCount + negCount;
  if (total === 0) return 0;
  
  // Normalized score: 1.0 is all positive, -1.0 is all negative
  return (posCount - negCount) / total;
}

/**
 * Analyzes an array of reviews to return an aggregate sentiment score.
 * Also extracts common themes (positive/negative tags).
 * @param {Array<Object>} reviews - Array of review objects containing `text` or `originalText`.
 * @returns {{ score: number, tags: { positive: string[], negative: string[] } }}
 */
function analyzeSpaceSentiment(reviews = []) {
  if (!reviews || !reviews.length) {
    return { score: 0, tags: { positive: [], negative: [] } };
  }

  let totalScore = 0;
  let validReviews = 0;

  // Track keyword frequency
  const posFreq = {};
  const negFreq = {};

  for (const r of reviews) {
    const text = r.text || r.body || r.originalText || '';
    if (!text) continue;

    const lower = text.toLowerCase();
    
    let revPos = 0;
    let revNeg = 0;

    for (const w of POSITIVE_KEYWORDS) {
      if (lower.includes(w)) {
        revPos++;
        posFreq[w] = (posFreq[w] || 0) + 1;
      }
    }
    for (const w of NEGATIVE_KEYWORDS) {
      if (lower.includes(w)) {
        revNeg++;
        negFreq[w] = (negFreq[w] || 0) + 1;
      }
    }

    const total = revPos + revNeg;
    if (total > 0) {
      validReviews++;
      totalScore += (revPos - revNeg) / total;
    }
  }

  const avgScore = validReviews > 0 ? (totalScore / validReviews) : 0;

  // Get top 3 tags for positive/negative based on frequency
  const getTop = (freqMap) => Object.entries(freqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(entry => entry[0]);

  return {
    score: parseFloat(avgScore.toFixed(2)),
    tags: {
      positive: getTop(posFreq),
      negative: getTop(negFreq)
    }
  };
}

module.exports = { analyzeTextSentiment, analyzeSpaceSentiment };
