/**
 * Great-circle distance between two lat/lng points, in kilometers.
 *
 * This is deliberately a local calculation, not a Google Distance Matrix API
 * call — the routing engine needs to check dozens of restaurants against a
 * customer location per order, and straight-line distance is accurate enough
 * for "which restaurants are within N km" radius matching. Google Maps API
 * is reserved for geocoding (turning addresses into lat/lng at signup/order
 * time) per Section 2.4 — not for repeated per-order distance checks.
 */
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

module.exports = { haversineDistanceKm };
