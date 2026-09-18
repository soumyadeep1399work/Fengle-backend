/**
 * Commission is a simple percentage of item_total (not delivery fee), taken
 * from the restaurant's current commission_rate_percent. Clubbed orders use
 * one rate since only one restaurant is ever involved (Section 4) — no
 * proportional splitting needed.
 */
function computeCommission(itemTotal, restaurant) {
  const rate = Number(restaurant.commission_rate_percent);
  return Number(((itemTotal * rate) / 100).toFixed(2));
}

module.exports = { computeCommission };
