'use strict';

const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in kilometers. */
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Attaches `distanceKm` to each space: the great-circle distance from the
 * request's (originLat, originLng), rounded to 2 decimals. `null` when the
 * request carried no origin, or the space itself has no coordinates to
 * measure against — never thrown, since a missing distance isn't an error.
 */
function attachDistanceKm(spaces, originLat, originLng) {
  const hasOrigin = Number.isFinite(originLat) && Number.isFinite(originLng);
  return spaces.map(space => {
    const lat = space.lat ?? space.location?.coordinates?.[1];
    const lng = space.lng ?? space.location?.coordinates?.[0];
    const distanceKm =
      hasOrigin && Number.isFinite(lat) && Number.isFinite(lng)
        ? Math.round(haversineDistanceKm(originLat, originLng, lat, lng) * 100) / 100
        : null;
    return { ...space, distanceKm };
  });
}

module.exports = { haversineDistanceKm, attachDistanceKm };
