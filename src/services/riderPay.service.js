const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");

// The formula, in one line, as shown to admins and stored with every payout:
const FORMULA =
  "max(min_payout, base_payout + per_km_rate x min(distance_km, tier_km) + per_km_rate_after_tier x max(0, distance_km - tier_km)) + incentive_per_delivery" +
  " (with no tier set: per_km_rate x distance_km)";

// Statuses in which a delivery is still to be done: the rider sees an estimated payout for these.
const ACTIVE_STATUSES = ["accepted", "picked_up", "on_the_way"];

const money = (n) => Number(Number(n).toFixed(2));

/** The live config: the newest row of rider_pay_config. Falls back to the old env placeholders if the table is empty. */
async function getCurrentConfig(conn = db) {
  const row = await conn("rider_pay_config").orderBy("id", "desc").first();
  if (row) return normalizeConfig(row);
  return normalizeConfig({
    id: null,
    base_payout: 0,
    per_km_rate: Number(process.env.RIDER_RATE_PER_KM) || 8,
    min_payout: Number(process.env.RIDER_MIN_EARNING_PER_DELIVERY) || 15,
    incentive_per_delivery: 0,
  });
}

function normalizeConfig(row) {
  return {
    id: row.id,
    base_payout: Number(row.base_payout),
    per_km_rate: Number(row.per_km_rate),
    min_payout: Number(row.min_payout),
    incentive_per_delivery: Number(row.incentive_per_delivery),
    // Two-rate distance pay: per_km_rate up to tier_km, per_km_rate_after_tier beyond it. Both null = a single rate.
    tier_km: row.tier_km == null ? null : Number(row.tier_km),
    per_km_rate_after_tier: row.per_km_rate_after_tier == null ? null : Number(row.per_km_rate_after_tier),
    created_by_admin_id: row.created_by_admin_id ?? null,
    created_at: row.created_at ?? null,
  };
}

/**
 * payout = max(min_payout, base_payout + per_km_rate x distance_km) + incentive_per_delivery
 * Returns { payout, breakdown } where breakdown shows every step (what the admin and the
 * rider can read to see how the figure was reached).
 */
function computePayout({ distanceKm, config }) {
  const distance = money(distanceKm);
  // A tier only applies when it has both a length and an after-rate; otherwise it is the old single rate.
  const tierKm = config.tier_km != null && Number(config.tier_km) > 0 && config.per_km_rate_after_tier != null ? Number(config.tier_km) : null;
  const afterRate = tierKm != null ? Number(config.per_km_rate_after_tier) : null;
  const extraKm = tierKm != null ? money(Math.max(0, distance - tierKm)) : 0;
  const extraPay = tierKm != null ? money(afterRate * extraKm) : 0;
  const firstKm = tierKm != null ? Math.min(distance, tierKm) : distance;
  const distancePay = money(config.per_km_rate * firstKm + extraPay); // total distance pay: the first tier plus anything beyond it
  const subtotal = money(config.base_payout + distancePay);
  const minApplied = subtotal < config.min_payout;
  const core = minApplied ? config.min_payout : subtotal;
  const payout = money(core + config.incentive_per_delivery);
  return {
    payout,
    breakdown: {
      formula: FORMULA,
      distance_km: distance,
      base_payout: config.base_payout,
      per_km_rate: config.per_km_rate,
      distance_pay: distancePay,
      tier_km: tierKm,
      per_km_rate_after_tier: afterRate,
      extra_distance_km: extraKm,
      extra_distance_pay: extraPay,
      subtotal,
      min_payout: config.min_payout,
      min_applied: minApplied,
      incentive_per_delivery: config.incentive_per_delivery,
      payout,
    },
  };
}

/** Kitchen -> drop-off distance, the same measure settlement has always used. */
function orderDistanceKm(order, restaurant) {
  return haversineDistanceKm(Number(restaurant.lat), Number(restaurant.lng), Number(order.delivery_lat), Number(order.delivery_lng));
}

/**
 * Freezes the rider's payout on a just-delivered order. Call inside the delivery
 * transaction. Safe to call twice: an order that already has a stored payout keeps it.
 */
async function recordPayoutOnDelivery(trx, order) {
  const existing = await trx("orders").where({ id: order.id }).select("rider_payout").first();
  if (existing && existing.rider_payout != null) return null;
  const restaurant = await trx("restaurants").where({ id: order.restaurant_id }).select("lat", "lng").first();
  if (!restaurant) return null;
  const config = await getCurrentConfig(trx);
  const { payout, breakdown } = computePayout({ distanceKm: orderDistanceKm(order, restaurant), config });
  await trx("orders").where({ id: order.id }).update({
    rider_payout: payout,
    rider_payout_breakdown: JSON.stringify({ ...breakdown, config_id: config.id }),
    rider_pay_config_id: config.id,
  });
  return payout;
}

/** The payout settlement should pay for an order: the frozen one, else the current formula (older orders). */
function payoutForSettlement({ order, restaurant, config }) {
  if (order.rider_payout != null) return { payout: money(order.rider_payout), stored: true };
  return { payout: computePayout({ distanceKm: orderDistanceKm(order, restaurant), config }).payout, stored: false };
}

/**
 * What a rider would earn for an order still to be delivered, under the LIVE config and the same distance measure
 * the frozen payout uses. null when the order isn't active or the distance can't be computed. The final payout is
 * frozen at delivery from whatever config is live then, so this is only an estimate.
 */
function estimatePayout({ order, restaurant, config }) {
  if (!ACTIVE_STATUSES.includes(order.status) || !restaurant) return null;
  const km = orderDistanceKm(order, restaurant);
  if (!Number.isFinite(km)) return null;
  return computePayout({ distanceKm: km, config }).payout;
}

function parseBreakdown(value) {
  if (value == null) return null;
  if (typeof value === "object") return value; // MySQL JSON columns arrive parsed
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { FORMULA, getCurrentConfig, normalizeConfig, computePayout, estimatePayout, ACTIVE_STATUSES, orderDistanceKm, recordPayoutOnDelivery, payoutForSettlement, parseBreakdown };
