'use strict';

/**
 * Generate a grid of coordinate points within a bounding box.
 * 
 * @param {Object} bounds - { north, south, east, west } in degrees.
 * @param {Number} stepKm - Distance between grid points in kilometers.
 * @returns {Array} Array of { lat, lng } points.
 */
function generateGrid(bounds, stepKm = 5) {
  const points = [];
  const LAT_KM_PER_DEGREE = 111.32;

  const latStep = stepKm / LAT_KM_PER_DEGREE;
  
  // Iterate from south to north
  for (let lat = bounds.south; lat <= bounds.north; lat += latStep) {
    // Longitude degree distance changes based on latitude
    const lngKmPerDegree = LAT_KM_PER_DEGREE * Math.cos(lat * Math.PI / 180);
    const lngStep = stepKm / lngKmPerDegree;
    
    // Iterate from west to east
    for (let lng = bounds.west; lng <= bounds.east; lng += lngStep) {
      points.push({ lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) });
    }
  }

  return points;
}

module.exports = {
  generateGrid
};
