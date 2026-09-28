'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// City matching for `?city=` filters.
//
// `Space.areaName` is whatever Google Maps called the place at scrape time, so
// one city is often stored under several names: Gurugram appears as both
// "Gurgaon, Haryana, India" and "Gurugram, Haryana, India"; Bengaluru as
// "Bangalore, …". opg-web's `/c/:category/:city` URLs use one canonical slug
// per city, so without aliases `/c/gyms/gurugram` silently missed ~70% of
// Gurugram's gyms. Each group lists every spelling of one city; a slug matching
// any of them matches all of them.
// ─────────────────────────────────────────────────────────────────────────────

const CITY_ALIASES = [
  ['gurugram', 'gurgaon'],
  ['bengaluru', 'bangalore'],
  ['mumbai', 'bombay'],
  ['kolkata', 'calcutta'],
  ['chennai', 'madras'],
  ['puducherry', 'pondicherry'],
  ['thiruvananthapuram', 'trivandrum'],
  ['kochi', 'cochin'],
  ['vadodara', 'baroda'],
  ['mysuru', 'mysore'],
  ['prayagraj', 'allahabad'],
  ['delhi', 'new-delhi'],
];

const escape = s => s.replace(/[[\]{}()*+?.,\\^$|#]/g, '\\$&');

/** Every known spelling of a city slug (hyphenated, lower-case), itself included. */
function cityVariants(city) {
  const slug = String(city || '').toLowerCase().trim().replace(/\s+/g, '-');
  const group = CITY_ALIASES.find(g => g.includes(slug));
  return group ? [...group] : [slug];
}

/**
 * `areaName` condition for a `city` query param. Tolerant of hyphenated slugs
 * ("new-delhi") matching a space-separated areaName ("New Delhi"), and of
 * every alias in CITY_ALIASES.
 */
function buildCityFilter(city) {
  const alternatives = cityVariants(city)
    .map(v => v.split('-').map(escape).join('[- ]'))
    .join('|');
  return { $regex: new RegExp(`(?:${alternatives})`, 'i') };
}

module.exports = { CITY_ALIASES, cityVariants, buildCityFilter };
