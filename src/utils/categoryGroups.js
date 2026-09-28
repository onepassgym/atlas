'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Category groups — bridges opg-web's /c/:category/:city landing slugs to the
// raw `Space.category` values this service actually writes (see CATEGORY_MAP
// in src/scraper/spaceProcessor.js).
//
// The six landing slugs (gyms/fitness/yoga/pilates/swimming/spaces) are opg-web's
// (ui/src/seo/spaceCategory.ts, CATEGORY_SLUGS) and opg-cms's (CategoryContent
// model) single source of truth for category naming — this file is the atlas-side
// mirror of the same grouping, applied to atlas's own category vocabulary so
// `GET /api/spaces?category=gyms&city=gurugram` returns something.
//
// The grouping itself follows opg-web's resolveCategory()/normalizeCategoryName()
// keyword heuristic exactly (including its quirks — e.g. "boxing_gym" contains
// "gym" but web's substring checks test for "boxing" first and classify it as
// Martial Arts, so it lands in SPACES here, not GYMS; "climbing_gym" hits no
// earlier keyword and falls through to the "gym" check, so it lands in GYMS).
// Keeping the two in lockstep means a space categorized as "Gym" on its own
// detail page also shows up under /c/gyms/:city.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_GROUP_VALUES = {
  gyms:     ['gym', 'climbing_gym'],
  fitness:  ['fitness_center', 'crossfit'],
  yoga:     ['yoga_studio'],
  pilates:  ['pilates_studio'],
  swimming: ['swimming_club'],
};

const CATEGORY_GROUP_SLUGS = [...Object.keys(CATEGORY_GROUP_VALUES), 'spaces'];

// Every named value that belongs to a *non-"spaces"* group. "spaces" is the
// catch-all bucket — anything not explicitly classified above, including raw
// category values this map has never seen (a future scraped type, a stray
// CATEGORY_MAP addition) — so it's expressed as $nin rather than a fixed list.
const NON_SPACES_VALUES = Object.values(CATEGORY_GROUP_VALUES).flat();

function isCategoryGroupSlug(slug) {
  return CATEGORY_GROUP_SLUGS.includes(slug);
}

/**
 * Builds the Mongo condition for a landing-page category slug. Returns
 * `undefined` when `slug` isn't a known group slug — callers should fall back
 * to treating it as a literal `Space.category` value (preserves the existing
 * `?category=gym` exact-match behavior for non-grouped callers).
 */
function categoryGroupFilter(slug) {
  if (slug === 'spaces') return { $nin: NON_SPACES_VALUES };
  const values = CATEGORY_GROUP_VALUES[slug];
  return values ? { $in: values } : undefined;
}

/**
 * Reverse of `categoryGroupFilter`: which landing slug a raw `Space.category`
 * value belongs to. Anything unclassified falls into the "spaces" catch-all,
 * matching the $nin semantics above.
 */
function categoryGroupForValue(value) {
  const normalized = String(value || '').toLowerCase().trim();
  for (const [slug, values] of Object.entries(CATEGORY_GROUP_VALUES)) {
    if (values.includes(normalized)) return slug;
  }
  return 'spaces';
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare families — which groups are close enough to compare head-to-head.
// A visitor weighing a "Gym" against a "Fitness Center" is making one choice,
// so the space comparison (services/compare, api/compareRoutes) treats a
// family as the unit of "similar category". Mirrored by opg-web's
// COMPARE_FAMILIES (ui/src/components/organisms/Compare/compareRules.ts).
// ─────────────────────────────────────────────────────────────────────────────

const COMPARE_FAMILIES = {
  gym:       ['gyms', 'fitness'],
  mind_body: ['yoga', 'pilates'],
  swimming:  ['swimming'],
  spaces:    ['spaces'],
};

function compareFamilyForGroup(groupSlug) {
  for (const [family, groups] of Object.entries(COMPARE_FAMILIES)) {
    if (groups.includes(groupSlug)) return family;
  }
  return 'spaces';
}

/** Mongo `category` condition matching every group in `groupSlug`'s family. */
function compareFamilyFilter(groupSlug) {
  const groups = COMPARE_FAMILIES[compareFamilyForGroup(groupSlug)];
  if (groups.includes('spaces')) return categoryGroupFilter('spaces');
  return { $in: groups.flatMap(g => CATEGORY_GROUP_VALUES[g]) };
}

module.exports = {
  CATEGORY_GROUP_SLUGS,
  COMPARE_FAMILIES,
  isCategoryGroupSlug,
  categoryGroupFilter,
  categoryGroupForValue,
  compareFamilyForGroup,
  compareFamilyFilter,
};
