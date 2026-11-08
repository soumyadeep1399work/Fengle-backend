const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");

/**
 * "Reached Restaurant" / "Reached Customer". The rider taps when they arrive; we stamp OUR clock, and keep the GPS the app sent plus the
 * distance from it to the place, so support can see delays. It never blocks on distance (the client wants manual exceptions): a far or
 * missing GPS fix just marks the arrival `manual`. Recorded once per order and kind; a repeat returns what was stored.
 */

const KINDS = {
  restaurant: { prefix: "reached_restaurant", statuses: ["accepted"], label: "the restaurant" },
  customer: { prefix: "reached_customer", statuses: ["picked_up", "on_the_way"], label: "the customer" },
};

const radiusMeters = () => {
  const n = Number(process.env.ARRIVAL_RADIUS_M);
  return Number.isFinite(n) && n > 0 ? n : 300;
};

/** Validates { lat?, lng?, accuracy_m?, manual? }. Returns { error } or { value }. */
function validate(body) {
  const b = body || {};
  const given = (v) => v !== undefined && v !== null && v !== "";
  const hasLat = given(b.lat), hasLng = given(b.lng);
  if (hasLat !== hasLng) return { error: "Send lat and lng together, or neither" };
  let lat = null, lng = null, accuracy = null;
  if (hasLat) {
    lat = Number(b.lat); lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return { error: "lat and lng must be real coordinates" };
  }
  if (given(b.accuracy_m)) {
    accuracy = Number(b.accuracy_m);
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) return { error: "accuracy_m must be a number of metres (0 or more)" };
  }
  if (b.manual !== undefined && typeof b.manual !== "boolean") return { error: "manual must be true or false" };
  return { value: { lat, lng, accuracy_m: accuracy, manual: b.manual === true } };
}

function present(row, prefix, kind) {
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    kind, reached_at: new Date(row[`${prefix}_at`]).toISOString(), lat: num(row[`${prefix}_lat`]), lng: num(row[`${prefix}_lng`]),
    accuracy_m: num(row[`${prefix}_accuracy_m`]), distance_m: num(row[`${prefix}_distance_m`]), manual: Boolean(row[`${prefix}_manual`]),
  };
}

/**
 * Records the arrival of the order's assigned rider. Returns { arrival, already_recorded } or { status, error } for the caller to send.
 * `order` is the row already checked to belong to this rider.
 */
async function record(order, kind, value) {
  const { prefix, statuses, label } = KINDS[kind];
  if (order[`${prefix}_at`]) return { arrival: present(order, prefix, kind), already_recorded: true };
  if (!statuses.includes(order.status)) {
    return { status: 409, error: `You can only mark arrival at ${label} while the order is ${statuses.join(" or ").replace(/_/g, " ")} (it is ${order.status.replace(/_/g, " ")})` };
  }

  const place = kind === "restaurant"
    ? await db("restaurants").where({ id: order.restaurant_id }).select("lat", "lng").first()
    : { lat: order.delivery_lat, lng: order.delivery_lng };
  const distance = value.lat !== null && place && place.lat != null ? Math.round(haversineDistanceKm(value.lat, value.lng, Number(place.lat), Number(place.lng)) * 1000) : null;
  const manual = value.manual || value.lat === null || distance === null || distance > radiusMeters();

  const changed = await db("orders").where({ id: order.id }).whereNull(`${prefix}_at`).update({
    [`${prefix}_at`]: new Date(), [`${prefix}_lat`]: value.lat, [`${prefix}_lng`]: value.lng, [`${prefix}_accuracy_m`]: value.accuracy_m,
    [`${prefix}_distance_m`]: distance, [`${prefix}_manual`]: manual,
  });
  const fresh = await db("orders").where({ id: order.id }).first();
  return { arrival: present(fresh, prefix, kind), already_recorded: changed === 0 };
}

/** What a requester may see of the arrival fields on an order read (the GPS detail is admin-only and stripped everywhere else). */
function visibleTo(row, type) {
  if (type === "rider") return { reached_restaurant_at: row.reached_restaurant_at || null, reached_customer_at: row.reached_customer_at || null };
  if (type === "restaurant") return { rider_arrived_at: row.reached_restaurant_at || null };
  return {};
}

module.exports = { KINDS, validate, record, visibleTo, radiusMeters };
