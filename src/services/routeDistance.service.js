const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");

/**
 * The trip distance for an order: kitchen -> drop-off by ROAD (Google Routes API), one number used for the customer fee, rider pay and the
 * rider alert. Matching kitchens and the catalog radius stay straight-line (utils/geo) - that is a service-area rule, not a trip length.
 *
 *   no GOOGLE_ROUTES_API_KEY  -> source "straight": exactly the old straight-line distance (nothing changes until the key is set)
 *   key set, API answers      -> source "road"  (TWO_WHEELER first, DRIVE as a fallback)
 *   key set, API fails/slow   -> source "estimate": straight x ROUTE_FALLBACK_FACTOR (default 1.3). Never blocks an order, never throws.
 *
 * Results are cached by origin/destination rounded to 5 decimals, so a cart quote and the order placed after it agree and a repeat
 * address costs nothing. 'road' is kept for good; an 'estimate' for ESTIMATE_TTL_MIN minutes.
 */

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ESTIMATE_TTL_MIN = 15;
const ESTIMATE_SPEED_KMPH = 20; // the same urban average the pickup ETA has always used

const round5 = (n) => Number(Number(n).toFixed(5));
const fallbackFactor = () => { const n = Number(process.env.ROUTE_FALLBACK_FACTOR); return Number.isFinite(n) && n >= 1 ? n : 1.3; };
const timeoutMs = () => { const n = Number(process.env.ROUTE_API_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 4000; };
const apiKey = () => (process.env.GOOGLE_ROUTES_API_KEY || "").trim();

const straightKm = (a, b) => haversineDistanceKm(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
const minutesFor = (km) => Math.max(1, Math.round((km / ESTIMATE_SPEED_KMPH) * 60));

/** One Routes API call for a travel mode. Returns { distance_m, duration_s } or null. */
async function callRoutes(key, from, to, mode, signal) {
  const res = await fetch(ROUTES_URL, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration" },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: Number(from.lat), longitude: Number(from.lng) } } },
      destination: { location: { latLng: { latitude: Number(to.lat), longitude: Number(to.lng) } } },
      travelMode: mode,
    }),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const route = body && Array.isArray(body.routes) ? body.routes[0] : null;
  if (!route || !Number.isFinite(Number(route.distanceMeters))) return null;
  const seconds = parseInt(String(route.duration || "").replace(/s$/, ""), 10);
  return { distance_m: Math.round(Number(route.distanceMeters)), duration_s: Number.isFinite(seconds) ? seconds : null };
}

/** TWO_WHEELER (India supports it), then DRIVE, within one overall timeout. null if neither answers. */
async function fetchRoad(from, to) {
  const key = apiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    for (const mode of ["TWO_WHEELER", "DRIVE"]) {
      try {
        const r = await callRoutes(key, from, to, mode, controller.signal);
        if (r) return r;
      } catch (err) {
        if (controller.signal.aborted) return null; // out of time: don't start another call
        console.error(`[routes] ${mode} request failed:`, err.message);
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function present({ distance_m, duration_s }, source) {
  return { distance_km: distance_m / 1000, duration_min: duration_s != null ? Math.max(1, Math.round(duration_s / 60)) : minutesFor(distance_m / 1000), source };
}

/**
 * The trip distance between two points: { distance_km (unrounded), duration_min, source }. `from` / `to` are { lat, lng }.
 * Never throws: any failure becomes an estimate.
 */
async function between(from, to) {
  const straight = straightKm(from, to);
  if (!apiKey()) return { distance_km: straight, duration_min: null, source: "straight" };

  const keyOf = { origin_lat: round5(from.lat), origin_lng: round5(from.lng), dest_lat: round5(to.lat), dest_lng: round5(to.lng) };
  try {
    const hit = await db("route_cache").where(keyOf).first();
    if (hit && (hit.source === "road" || (hit.expires_at && new Date(hit.expires_at) > new Date()))) return present({ distance_m: hit.distance_m, duration_s: hit.duration_s }, hit.source);
  } catch (err) {
    console.error("[routes] cache read failed:", err.message);
  }

  let result;
  try {
    const road = await fetchRoad(from, to);
    result = road
      ? { ...road, source: "road", expires_at: null }
      : { distance_m: Math.round(straight * fallbackFactor() * 1000), duration_s: Math.round(minutesFor(straight * fallbackFactor()) * 60), source: "estimate", expires_at: new Date(Date.now() + ESTIMATE_TTL_MIN * 60 * 1000) };
  } catch (err) {
    console.error("[routes] lookup failed, using an estimate:", err.message);
    result = { distance_m: Math.round(straight * fallbackFactor() * 1000), duration_s: Math.round(minutesFor(straight * fallbackFactor()) * 60), source: "estimate", expires_at: new Date(Date.now() + ESTIMATE_TTL_MIN * 60 * 1000) };
  }
  try {
    const row = { ...keyOf, distance_m: result.distance_m, duration_s: result.duration_s, source: result.source, expires_at: result.expires_at };
    const existing = await db("route_cache").where(keyOf).first("id");
    if (existing) await db("route_cache").where({ id: existing.id }).update({ distance_m: row.distance_m, duration_s: row.duration_s, source: row.source, expires_at: row.expires_at, created_at: new Date() });
    else await db("route_cache").insert(row);
  } catch (err) {
    console.error("[routes] cache write failed:", err.message); // a lost cache row only costs a repeat lookup
  }
  return present(result, result.source);
}

/** Column values for orders.route_* from a between() result (distance rounded to 2 dp). */
const orderColumns = (route) => ({
  route_distance_km: Number(route.distance_km.toFixed(2)),
  route_duration_min: route.duration_min,
  route_source: route.source,
});

/** The stored road/estimate distance of an order, or null (nothing stored, or only the old straight line). */
function storedRoute(order) {
  if (order && order.route_distance_km != null && (order.route_source === "road" || order.route_source === "estimate")) {
    return { distance_km: Number(order.route_distance_km), duration_min: order.route_duration_min, source: order.route_source };
  }
  return null;
}

/**
 * The route for an order that is already placed: what is stored, else (an order from before road distances, or placed with no API key)
 * computed now from the kitchen to the drop-off and, when it is a real road/estimate figure, stored on the order. Never throws.
 * `restaurant` needs lat/lng.
 */
async function ensureForOrder(order, restaurant, conn = db) {
  const stored = storedRoute(order);
  if (stored) return stored;
  const route = await between({ lat: restaurant.lat, lng: restaurant.lng }, { lat: order.delivery_lat, lng: order.delivery_lng });
  if (route.source !== "straight") {
    // Return exactly what gets stored (2 dp), so the first read and every later read of this order measure the same distance.
    const stored2 = { ...route, distance_km: Number(route.distance_km.toFixed(2)) };
    try {
      await conn("orders").where({ id: order.id }).update(orderColumns(stored2));
    } catch (err) {
      console.error("[routes] could not store the route on order", order.id, err.message);
    }
    return stored2;
  }
  return route;
}

module.exports = { between, ensureForOrder, storedRoute, orderColumns, straightKm, fallbackFactor, ESTIMATE_TTL_MIN };
