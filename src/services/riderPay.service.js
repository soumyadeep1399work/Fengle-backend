const db = require("../config/db");
const shipping = require("./shippingRules.service");

// The formula, in one line, as shown to admins and stored with every payout:
const FORMULA =
  "Admin-managed shipping rules (kind rider_pay): the base rule (flat + per-km bands over the trip distance), then any add rules, then min/max clamps." +
  " The simple shape is max(min_payout, base_payout + per_km_rate x min(distance_km, tier_km) + per_km_rate_after_tier x max(0, distance_km - tier_km) + incentive_per_delivery)";

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

/** Kitchen -> drop-off distance, the same measure settlement has always used (one function: shippingRules.tripDistanceKm). */
function orderDistanceKm(order, restaurant) {
  return shipping.tripDistanceKm(order, restaurant);
}

/**
 * The frozen explanation of a rules-based payout. Keeps every key the old single-config breakdown had (filled in when the base rule
 * is the simple 1- or 2-band shape) and adds `applied`: every rule that changed the amount, with before/after, which is the real
 * explanation when the rule set is richer than that.
 */
function breakdownFromRules(result, distanceKm) {
  const b = result.breakdown;
  const bands = b.base.bands;
  const simple = bands.length <= 2;
  const tier = simple && bands.length === 2 ? bands[0].to_km : null;
  const mins = result.applied.filter((a) => a.type === "min");
  const adds = result.applied.filter((a) => a.type === "add");
  return {
    formula: FORMULA,
    source: "rules",
    distance_km: b.distance_km,
    base_payout: b.base.flat,
    per_km_rate: simple && bands[0] ? bands[0].per_km : null,
    distance_pay: b.base.bands_amount,
    tier_km: tier,
    per_km_rate_after_tier: tier != null ? bands[1].per_km : null,
    extra_distance_km: tier != null ? bands[1].km_in_band : 0,
    extra_distance_pay: tier != null ? bands[1].amount : 0,
    subtotal: b.base_amount,
    min_payout: mins.length ? Number(mins[0].charge.amount) : null,
    min_applied: mins.some((m) => m.effect.delta > 0),
    incentive_per_delivery: adds.length && adds.every((a) => !a.charge.percent) ? Number(adds.reduce((s, a) => s + Number(a.charge.flat || 0), 0).toFixed(2)) : adds.length ? null : 0,
    payout: result.amount,
    zone: result.zone,
    applied: result.applied.map((a) => ({ rule_id: a.rule_id, name: a.name, type: a.type, effect: a.effect })),
  };
}

/**
 * What a rider earns for a delivery under the shipping rules (kind rider_pay), evaluated at `at`. Falls back to the legacy
 * rider_pay_config formula when no rider_pay rule prices the trip, so a delivery can never be left unpriced.
 * Returns { payout, breakdown, configId } (configId only for a legacy fallback).
 */
async function riderPayout({ order, restaurant, at = new Date(), conn = db, ruleSet }) {
  const km = orderDistanceKm(order, restaurant);
  const r = await shipping.compute({
    kind: "rider_pay", distanceKm: km, orderValue: Number(order.item_total), at,
    dropoff: { lat: order.delivery_lat, lng: order.delivery_lng }, restaurant, conn, ruleSet,
  });
  if (r.fallback) {
    const config = await getCurrentConfig(conn);
    const legacy = computePayout({ distanceKm: km, config });
    return { payout: legacy.payout, breakdown: { ...legacy.breakdown, source: "legacy", config_id: config.id }, configId: config.id };
  }
  return { payout: r.amount, breakdown: { ...breakdownFromRules(r, km), config_id: null }, configId: null };
}

/**
 * Freezes the rider's payout on a just-delivered order, evaluated at delivery time. Call inside the delivery
 * transaction. Safe to call twice: an order that already has a stored payout keeps it.
 */
async function recordPayoutOnDelivery(trx, order) {
  const existing = await trx("orders").where({ id: order.id }).select("rider_payout", "item_total").first();
  if (existing && existing.rider_payout != null) return null;
  const restaurant = await trx("restaurants").where({ id: order.restaurant_id }).select("lat", "lng", "radius_km").first();
  if (!restaurant) return null;
  const { payout, breakdown, configId } = await riderPayout({ order: { ...order, item_total: existing ? existing.item_total : order.item_total }, restaurant, at: new Date(), conn: trx });
  await trx("orders").where({ id: order.id }).update({
    rider_payout: payout,
    rider_payout_breakdown: JSON.stringify(breakdown),
    rider_pay_config_id: configId,
  });
  return payout;
}

/** The payout settlement should pay for an order: the frozen one, else the current rules (older orders). */
async function settlementPayout({ order, restaurant, conn = db, ruleSet }) {
  if (order.rider_payout != null) return { payout: money(order.rider_payout), stored: true };
  const { payout } = await riderPayout({ order, restaurant, conn, ruleSet });
  return { payout, stored: false };
}

/**
 * What a rider would earn for an order still to be delivered, under the LIVE rules and the same distance measure the frozen
 * payout uses. null when the order isn't active or can't be measured. The final payout is frozen at delivery from whatever rules
 * are live then, so this is only an estimate.
 */
async function estimatePayout({ order, restaurant, conn = db, ruleSet }) {
  if (!ACTIVE_STATUSES.includes(order.status) || !restaurant) return null;
  try {
    const { payout } = await riderPayout({ order, restaurant, conn, ruleSet });
    return Number.isFinite(payout) ? payout : null;
  } catch {
    return null;
  }
}

/**
 * The live rider rules as the old single-config shape, ONLY while they really are that shape (one unconditional everywhere base rule
 * of 1-2 bands, at most one `min` and one flat `add`, nothing in a zone or dated); otherwise null. GET /admin/settings/rider-pay and
 * GET /riders/me/rate use it so older screens keep working while the rules are simple.
 */
async function simpleConfig(conn = db) {
  const { rules } = await shipping.loadRuleSet(conn, "rider_pay");
  const plain = (r) => r.zone_id == null && !r.valid_from && !r.valid_to && Object.keys(r.conditions || {}).length === 0;
  if (!rules.length || !rules.every(plain)) return null;
  const bases = rules.filter((r) => r.type === "base");
  const mins = rules.filter((r) => r.type === "min");
  const adds = rules.filter((r) => r.type === "add");
  if (bases.length !== 1 || mins.length > 1 || adds.length > 1 || bases.length + mins.length + adds.length !== rules.length) return null;
  const c = bases[0].charge;
  const bands = c.bands || [];
  if (c.after_kitchen_radius || bands.length < 1 || bands.length > 2) return null;
  if (adds[0] && (adds[0].charge.percent || !adds[0].charge.flat)) return null;
  return {
    base_payout: Number(c.flat || 0),
    per_km_rate: Number(bands[0].per_km),
    min_payout: mins[0] ? Number(mins[0].charge.amount) : 0,
    incentive_per_delivery: adds[0] ? Number(adds[0].charge.flat) : 0,
    tier_km: bands.length === 2 ? Number(bands[0].to_km) : null,
    per_km_rate_after_tier: bands.length === 2 ? Number(bands[1].per_km) : null,
  };
}

function parseBreakdown(value) {
  if (value == null) return null;
  if (typeof value === "object") return value; // MySQL JSON columns arrive parsed
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { FORMULA, getCurrentConfig, normalizeConfig, computePayout, riderPayout, estimatePayout, settlementPayout, simpleConfig, ACTIVE_STATUSES, orderDistanceKm, recordPayoutOnDelivery, parseBreakdown };
