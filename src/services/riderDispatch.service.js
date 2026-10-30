const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");
const { notifyLater } = require("./push.service");
const orderPush = require("./orderNotifications.service");
const { applyDocumentsGate } = require("./partnerDocuments.service");

/**
 * Rider dispatch: who is online, who is free, and who gets an accepted order.
 *
 * "Online" = riders.status 'active' + approved + documents in order + a known location. There is deliberately no
 * location-staleness filter (pings are foreground-only, so a rider with a locked phone would silently stop getting orders).
 * "Free" = online and not on an accepted / picked-up / on-the-way order.
 *
 * Every assignment goes through assignWaitingOrders() / assignOne(), serialised by an in-process lock (the API runs as one PM2
 * instance) and written with a conditional UPDATE, so two triggers racing can never give an order two riders or a rider two orders.
 */

const BUSY_STATUSES = ["accepted", "picked_up", "on_the_way"];
const TICK_MS = 30 * 1000;
const NO_RIDERS_MESSAGE = "No delivery partners are online right now. Please try again in a few minutes.";

function onlineRiderQuery(conn = db) {
  return conn("riders")
    .where({ status: "active", verification_status: "approved" })
    .modify((qb) => applyDocumentsGate(qb, "documents_valid_until"))
    .whereNotNull("last_known_lat")
    .whereNotNull("last_known_lng");
}

/** True if at least one rider could take an order right now (busy riders count: they free up and pick it up). */
async function hasOnlineRider() {
  const row = await onlineRiderQuery().count({ n: "*" }).first();
  return Number(row.n) > 0;
}

async function busyRiderIds() {
  return (await db("orders").whereIn("status", BUSY_STATUSES).whereNotNull("rider_id").select("rider_id")).map((r) => r.rider_id);
}

/** Nearest free online rider to the kitchen, or null. `alsoBusy` = riders already given an order in the current pass. */
async function pickNearestFreeRider(restaurant, busyIds, alsoBusy = []) {
  const taken = new Set([...busyIds, ...alsoBusy].map(Number));
  const candidates = (await onlineRiderQuery()).filter((r) => !taken.has(Number(r.id)));
  if (candidates.length === 0) return null;
  return candidates
    .map((r) => ({ rider: r, distanceKm: haversineDistanceKm(Number(restaurant.lat), Number(restaurant.lng), Number(r.last_known_lat), Number(r.last_known_lng)) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0].rider;
}

/** Conditional write: only an accepted order that still has no rider takes it. Returns true if this call won. */
async function claim(orderId, riderId) {
  const n = await db("orders").where({ id: orderId, status: "accepted" }).whereNull("rider_id").update({ rider_id: riderId });
  if (n === 1) notifyLater(() => orderPush.riderAssigned(orderId));
  return n === 1;
}

let chain = Promise.resolve();
/** Runs fn after every earlier dispatch call has finished (errors don't poison the chain). */
function serialised(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Assigns one accepted order to the nearest free rider. Returns the rider id, or null if nobody is free (it then waits). */
function assignOne(orderId) {
  return serialised(async () => {
    const order = await db("orders").where({ id: orderId }).first();
    if (!order || order.status !== "accepted" || order.rider_id) return order && order.rider_id ? order.rider_id : null;
    const restaurant = await db("restaurants").where({ id: order.restaurant_id }).first();
    const rider = await pickNearestFreeRider(restaurant, await busyRiderIds());
    if (!rider) return null;
    return (await claim(orderId, rider.id)) ? rider.id : null;
  });
}

/**
 * Gives every accepted-but-riderless order, oldest first, to the nearest free online rider. A rider handed an order earlier in the
 * same pass counts as busy for the rest. Returns [{ order_id, rider_id }].
 */
function assignWaitingOrders() {
  return serialised(async () => {
    const waiting = await db("orders").where({ status: "accepted" }).whereNull("rider_id").orderBy("created_at", "asc").orderBy("id", "asc").select("id", "restaurant_id");
    if (waiting.length === 0) return [];
    const busy = await busyRiderIds();
    const givenThisPass = [];
    const done = [];
    const restaurants = new Map();
    for (const o of waiting) {
      if (!restaurants.has(o.restaurant_id)) restaurants.set(o.restaurant_id, await db("restaurants").where({ id: o.restaurant_id }).first());
      const rider = await pickNearestFreeRider(restaurants.get(o.restaurant_id), busy, givenThisPass);
      if (!rider) break; // nobody free: the rest keep waiting
      if (await claim(o.id, rider.id)) {
        givenThisPass.push(rider.id);
        done.push({ order_id: o.id, rider_id: rider.id });
      }
    }
    return done;
  });
}

/** assignWaitingOrders() that never throws — for triggers inside another request, where a dispatch hiccup must not fail that request. */
async function assignWaitingOrdersSafe() {
  try {
    return await assignWaitingOrders();
  } catch (err) {
    console.error("[dispatch] assigning waiting orders failed:", err.message);
    return [];
  }
}

let timer = null;
/** Safety net: picks up anything the event triggers missed. Started from server.js (not app.js) so tests never run it. */
function startTick() {
  if (timer) return;
  timer = setInterval(() => { assignWaitingOrdersSafe(); }, TICK_MS);
  timer.unref();
}

module.exports = { onlineRiderQuery, hasOnlineRider, assignOne, assignWaitingOrders, assignWaitingOrdersSafe, startTick, TICK_MS, BUSY_STATUSES, NO_RIDERS_MESSAGE };
