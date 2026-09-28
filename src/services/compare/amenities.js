'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical amenity features for side-by-side comparison.
//
// `Space.amenitySlugs` is not comparable as-is: the scraper writes both the
// per-item slug ("-restroom") and a section-concatenated one
// ("amenities-restroom-wi-fi-free-wi-fi-swimming-pool") for the same venue, and
// the populated `amenityIds[].label` carries a Material icon glyph prefix. So a
// raw set-diff of slugs across two spaces reports phantom differences.
//
// Instead, every feature here is detected by pattern over the joined slugs +
// labels — a concatenated slug still contains each feature's own token — and
// reported once. Only features listed here are compared; anything else stays
// on the detail page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `benefit: false` marks a fact that isn't an advantage (appointment needed)
 * — shown in the matrix, never counted toward a space's amenity score.
 */
const AMENITY_FEATURES = [
  { key: 'shower',          label: 'Showers',                group: 'facilities', benefit: true,  re: /shower/ },
  { key: 'restroom',        label: 'Restrooms',              group: 'facilities', benefit: true,  re: /restroom|(?<!gender-neutral-)toilet/ },
  { key: 'wifi',            label: 'Wi-Fi',                  group: 'facilities', benefit: true,  re: /wi-?fi/ },
  { key: 'pool',            label: 'Swimming pool',          group: 'facilities', benefit: true,  re: /swimming-pool|(?<!car-)pool/ },
  { key: 'sauna',           label: 'Sauna',                  group: 'facilities', benefit: true,  re: /sauna/ },
  { key: 'steam',           label: 'Steam room',             group: 'facilities', benefit: true,  re: /steam/ },
  { key: 'locker',          label: 'Lockers',                group: 'facilities', benefit: true,  re: /locker/ },
  { key: 'ac',              label: 'Air conditioning',       group: 'facilities', benefit: true,  re: /air-?condition/ },
  // "wheelchair-accessible-car-park" must not read as parking — match only
  // the explicit parking kinds Google lists under its "Parking" section.
  { key: 'parking',         label: 'Parking',                group: 'access',     benefit: true,  re: /(?:free|paid|on-site)-parking|parking-(?:lot|garage)|street-parking|valet/ },
  { key: 'wheelchair',      label: 'Wheelchair accessible',  group: 'access',     benefit: true,  re: /wheelchair/ },
  { key: 'gender_neutral',  label: 'Gender-neutral toilets', group: 'access',     benefit: true,  re: /gender-neutral/ },
  { key: 'lgbtq',           label: 'LGBTQ+ friendly',        group: 'access',     benefit: true,  re: /lgbtq/ },
  { key: 'upi',             label: 'UPI / mobile pay',       group: 'payments',   benefit: true,  re: /google-pay|nfc|upi|phonepe|paytm/ },
  { key: 'cards',           label: 'Card payments',          group: 'payments',   benefit: true,  re: /credit-card|debit-card/ },
  { key: 'online_classes',  label: 'Online classes',         group: 'services',   benefit: true,  re: /online-class/ },
  { key: 'outdoor',         label: 'Outdoor sessions',       group: 'services',   benefit: true,  re: /outdoor-service/ },
  { key: 'appointment',     label: 'Appointment required',   group: 'services',   benefit: false, re: /appointment-required/ },
];

/** Lowercase, hyphenate, and drop icon-font glyphs (Private Use Area) from a label. */
function labelToToken(label) {
  return String(label)
    .replace(/[-]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-');
}

/**
 * Detects canonical amenity features on a space.
 * @returns {{ known: boolean, features: Array<{key,label,group,benefit}> }}
 *   `known: false` when the space carries no amenity data at all — distinct
 *   from "has none", so the UI can say "not listed" instead of a row of ✗.
 */
function normalizeAmenities(space) {
  const tokens = [
    ...(Array.isArray(space.amenitySlugs) ? space.amenitySlugs : []),
    ...(Array.isArray(space.amenityIds) ? space.amenityIds.map(a => a && (a.slug || labelToToken(a.label || ''))) : []),
  ].filter(Boolean).map(t => String(t).toLowerCase());

  if (tokens.length === 0) return { known: false, features: [] };

  const haystack = tokens.join(' ');
  const features = AMENITY_FEATURES
    .filter(f => f.re.test(haystack))
    .map(({ key, label, group, benefit }) => ({ key, label, group, benefit }));

  return { known: true, features };
}

module.exports = { AMENITY_FEATURES, normalizeAmenities };
