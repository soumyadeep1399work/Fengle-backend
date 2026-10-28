const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");

// The formula, in one line, as shown to admins and stored with every payout:
const FORMULA = "max(min_payout, base_payout + per_km_rate x distance_km) + incentive_per_delivery";

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
  const distancePay = money(config.per_km_rate * distance);
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

function parseBreakdown(value) {
  if (value == null) return null;
  if (typeof value === "object") return value; // MySQL JSON columns arrive parsed
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { FORMULA, getCurrentConfig, normalizeConfig, computePayout, recordPayoutOnDelivery, payoutForSettlement, parseBreakdown };
