const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");
const { OFFSET_MIN } = require("../utils/reportRange");

/**
 * The single source of truth for what a delivery costs the customer (kind `customer_fee`) and what a rider earns for it
 * (kind `rider_pay`). WooCommerce-style: zones + rules with conditions, admin-managed (see adminShipping.controller.js).
 *
 *   zone    = the first active zone (lowest priority number) whose circle contains the DROP-OFF (or whose pincode matches, when
 *             a pincode is known); none matching = the implicit "everywhere" zone (null).
 *   base    = first matching `base` rule by priority in the zone's own rules; if the zone has none, in the zone_id=null rules.
 *             amount = flat + sum(per_km x km inside each band). `after_kitchen_radius` (customer fee only) counts only the km
 *             beyond the kitchen's own radius_km, i.e. today's "free inside the radius".
 *   then    = every matching `add` (flat and/or percent of the RUNNING amount), then every matching `min`/`max` clamp, then (customer
 *             fee only) any matching `free`, which zeroes the amount. Zone rules run before everywhere rules; priority within.
 *   result  = rounded to 2 dp at every step, so the explanation adds up.
 *
 * Conditions (all optional, ANDed): distance_km {min,max} (the whole trip, kitchen -> drop-off), order_value {min,max} (item_total
 * after dish offers, before GST and coupon), time {days:[0-6, 0=Sunday], from:"HH:MM", to:"HH:MM"} in IST (from > to wraps
 * midnight; a day refers to the day the window STARTS). min inclusive, max exclusive.
 */

const KINDS = ["customer_fee", "rider_pay"];
const TYPES = ["base", "add", "free", "min", "max"];
const money = (n) => Number(Number(n).toFixed(2));

const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

const byPriority = (a, b) => a.priority - b.priority || a.id - b.id;

/** Kitchen -> drop-off, in km: the one distance measure used for rider pay, customer fee conditions and estimates. Change it here. */
function tripDistanceKm(order, restaurant) {
  return haversineDistanceKm(Number(restaurant.lat), Number(restaurant.lng), Number(order.delivery_lat), Number(order.delivery_lng));
}

function presentZone(r) {
  return {
    id: r.id, name: r.name, is_active: Boolean(r.is_active), priority: r.priority,
    match: parseJson(r.match, { pincodes: [], circles: [] }), created_at: r.created_at, updated_at: r.updated_at,
  };
}

function presentRule(r) {
  return {
    id: r.id, kind: r.kind, zone_id: r.zone_id, name: r.name, is_active: Boolean(r.is_active), priority: r.priority, type: r.type,
    conditions: parseJson(r.conditions, {}), charge: parseJson(r.charge, {}), valid_from: r.valid_from, valid_to: r.valid_to,
    created_by_admin_id: r.created_by_admin_id, created_at: r.created_at, updated_at: r.updated_at,
  };
}

/** Active, non-deleted zones and the kind's rules, loaded once so a batch of orders doesn't re-query per order. */
async function loadRuleSet(conn, kind) {
  const [zones, rules] = await Promise.all([
    conn("shipping_zones").where({ is_deleted: false, is_active: true }).orderBy("priority").orderBy("id"),
    conn("shipping_rules").where({ kind, is_deleted: false, is_active: true }).orderBy("priority").orderBy("id"),
  ]);
  return { zones: zones.map(presentZone), rules: rules.map(presentRule) };
}

function inEffect(rule, at) {
  if (rule.valid_from && new Date(rule.valid_from) > at) return false;
  if (rule.valid_to && new Date(rule.valid_to) <= at) return false;
  return true;
}

function zoneContains(zone, dropoff) {
  if (!dropoff) return false;
  const { circles = [], pincodes = [] } = zone.match || {};
  if (dropoff.lat != null && dropoff.lng != null && Number.isFinite(Number(dropoff.lat)) && Number.isFinite(Number(dropoff.lng))) {
    for (const c of circles) {
      if (haversineDistanceKm(Number(dropoff.lat), Number(dropoff.lng), Number(c.lat), Number(c.lng)) <= Number(c.radius_km)) return true;
    }
  }
  return Boolean(dropoff.pincode) && pincodes.map(String).includes(String(dropoff.pincode));
}

const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };

/** Day of week (0 = Sunday) and minutes since midnight in the report timezone (IST). */
function localParts(at) {
  const shifted = new Date(new Date(at).getTime() + OFFSET_MIN * 60000);
  return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

function timeMatches(t, at) {
  const { day, minutes } = localParts(at);
  const days = Array.isArray(t.days) && t.days.length ? t.days.map(Number) : null;
  if (!t.from && !t.to) return !days || days.includes(day);
  const from = toMinutes(t.from);
  const to = toMinutes(t.to);
  if (from < to) return (!days || days.includes(day)) && minutes >= from && minutes < to;
  // from > to wraps midnight: the evening part belongs to today, the after-midnight part to the window that began yesterday
  if (minutes >= from) return !days || days.includes(day);
  if (minutes < to) return !days || days.includes((day + 6) % 7);
  return false;
}

function rangeMatches(range, value) {
  if (!range) return true;
  if (value == null || !Number.isFinite(Number(value))) return false;
  if (range.min != null && Number(value) < Number(range.min)) return false;
  if (range.max != null && Number(value) >= Number(range.max)) return false;
  return true;
}

function conditionsMatch(conditions, ctx) {
  const c = conditions || {};
  if (c.distance_km && !rangeMatches(c.distance_km, ctx.distanceKm)) return false;
  if (c.order_value && !rangeMatches(c.order_value, ctx.orderValue)) return false;
  if (c.time && !timeMatches(c.time, ctx.at)) return false;
  return true;
}

/** flat + sum(per_km x km inside each band) over `km` (the distance being charged). */
function baseAmount(charge, km) {
  let bandsAmount = 0;
  const bands = [];
  for (const b of charge.bands || []) {
    const upper = b.to_km == null ? Infinity : Number(b.to_km);
    const inside = Math.max(0, Math.min(km, upper) - Number(b.from_km));
    const amount = Number(b.per_km) * inside;
    bandsAmount += amount;
    bands.push({ from_km: Number(b.from_km), to_km: b.to_km == null ? null : Number(b.to_km), per_km: Number(b.per_km), km_in_band: money(inside), amount: money(amount) });
  }
  const flat = Number(charge.flat || 0);
  return { flat: money(flat), bands, bands_amount: money(bandsAmount), amount: money(flat + bandsAmount) };
}

/**
 * Works out one delivery. Returns { amount, zone, applied, breakdown, warnings, fallback }.
 * `fallback: true` (amount null) means no active rule of this kind priced it — the callers' wrappers then use the legacy behaviour,
 * so a missing rule can never leave a delivery unpriced.
 */
async function compute({ kind, distanceKm, orderValue, at = new Date(), dropoff, restaurant, conn = db, ruleSet, zone: zoneOverride }) {
  const set = ruleSet || (await loadRuleSet(conn, kind));
  const when = new Date(at);
  const warnings = [];
  const distance = Number(distanceKm);

  const zone = zoneOverride !== undefined ? zoneOverride : set.zones.find((z) => zoneContains(z, dropoff)) || null;
  const live = set.rules.filter((r) => inEffect(r, when));
  const ctx = { distanceKm: distance, orderValue: orderValue == null ? undefined : Number(orderValue), at: when };
  const matching = (rules) => rules.filter((r) => conditionsMatch(r.conditions, ctx)).sort(byPriority);
  const zoneRules = zone ? live.filter((r) => r.zone_id === zone.id) : [];
  const everywhere = live.filter((r) => r.zone_id == null);

  const baseRule = matching(zoneRules.filter((r) => r.type === "base"))[0] || matching(everywhere.filter((r) => r.type === "base"))[0];
  if (!baseRule) return { amount: null, zone: zone && { id: zone.id, name: zone.name }, applied: [], breakdown: { distance_km: money(distance) }, warnings: ["no_base_rule_matched"], fallback: true };

  const radius = restaurant && restaurant.radius_km != null ? Number(restaurant.radius_km) : null;
  if (baseRule.charge.after_kitchen_radius && radius === null) warnings.push("restaurant_radius_unknown_treated_as_0");
  const chargeableKm = baseRule.charge.after_kitchen_radius ? Math.max(0, distance - (radius || 0)) : distance;
  const base = baseAmount(baseRule.charge, chargeableKm);

  let amount = base.amount;
  const applied = [{ rule_id: baseRule.id, name: baseRule.name, type: "base", charge: baseRule.charge, effect: { before: 0, after: amount, delta: amount } }];
  const steps = [{ rule_id: baseRule.id, name: baseRule.name, type: "base", before: 0, after: amount }];
  const apply = (rule, after) => {
    const next = money(after);
    applied.push({ rule_id: rule.id, name: rule.name, type: rule.type, charge: rule.charge, effect: { before: amount, after: next, delta: money(next - amount) } });
    steps.push({ rule_id: rule.id, name: rule.name, type: rule.type, before: amount, after: next });
    amount = next;
  };

  const others = (type) => [...matching(zoneRules.filter((r) => r.type === type)), ...matching(everywhere.filter((r) => r.type === type))];
  for (const r of others("add")) apply(r, amount + Number(r.charge.flat || 0) + (amount * Number(r.charge.percent || 0)) / 100);
  for (const r of [...others("min"), ...others("max")]) {
    // min then max, each group in zone-then-everywhere priority order
    apply(r, r.type === "min" ? Math.max(amount, Number(r.charge.amount)) : Math.min(amount, Number(r.charge.amount)));
  }
  if (kind === "customer_fee") for (const r of others("free")) apply(r, 0);

  return {
    amount: money(amount),
    zone: zone ? { id: zone.id, name: zone.name } : null,
    applied,
    breakdown: {
      distance_km: money(distance), chargeable_km: money(chargeableKm), base_amount: base.amount,
      base: { rule_id: baseRule.id, flat: base.flat, bands: base.bands, bands_amount: base.bands_amount, after_kitchen_radius: Boolean(baseRule.charge.after_kitchen_radius) },
      steps,
    },
    warnings, fallback: false,
  };
}

/**
 * The customer's delivery fee for a trip. Falls back to the old hard-coded rule when no customer_fee rule priced it. Used by the
 * cart quote, order placement and the reject-cascade reassignment, so the three can never disagree.
 */
async function customerFee({ distanceKm, restaurant, orderValue, at = new Date(), dropoff, conn = db, ruleSet }) {
  const r = await compute({ kind: "customer_fee", distanceKm, orderValue, at, dropoff, restaurant, conn, ruleSet });
  if (r.fallback) {
    const fee = require("./routing.service").computeDeliveryFee(distanceKm, restaurant);
    return { fee, breakdown: { source: "legacy", distance_km: money(distanceKm), fee } };
  }
  return { fee: r.amount, breakdown: { source: "rules", zone: r.zone, applied: r.applied, ...r.breakdown } };
}

module.exports = { KINDS, TYPES, compute, customerFee, loadRuleSet, tripDistanceKm, baseAmount, presentRule, presentZone, inEffect, timeMatches, zoneContains, parseJson, money };
