// Dev-only helpers so the Customer App can be tested end to end before the
// Restaurant/Rider panels exist. Used by scripts/advance-order.js,
// scripts/add-credit.js and the /dev routes (which are never mounted in
// production — see routes/index.js).
//
// advanceOrder drives the REAL order controller handlers (acting as the
// order's restaurant / assigned rider), so ETA, COD collection, rider
// auto-assignment and every state-machine check behave exactly as they will
// in production — nothing here writes order status directly.
const db = require("../config/db");
const orderController = require("../controllers/order.controller");
const wallet = require("./wallet.service");
const { notifyLater } = require("./push.service");
const orderPush = require("./orderNotifications.service");

const STEP_ORDER = ["placed", "accepted", "picked_up", "on_the_way", "delivered"];
const DEV_RIDER_PHONE = "9000000201"; // same rider scripts/seed.js creates

async function call(handler, req) {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  await handler({ body: {}, query: {}, ...req }, res);
  if (res.statusCode >= 400) throw new Error((res.body && res.body.error) || `HTTP ${res.statusCode}`);
  return res.body;
}

// With a single dev rider, concurrent orders would starve autoAssignRider
// (it skips busy riders) and leave later orders rider-less — so fall back to
// assigning the dev rider directly. Dev only, and the reason this file exists.
async function ensureRider(orderId) {
  const order = await db("orders").where({ id: orderId }).first();
  if (order.rider_id) return order;

  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).first();
  const fields = { status: "active", last_known_lat: restaurant.lat, last_known_lng: restaurant.lng };
  let rider = await db("riders").where({ phone: DEV_RIDER_PHONE }).first();
  if (rider) {
    await db("riders").where({ id: rider.id }).update(fields);
  } else {
    const [id] = await db("riders").insert({ phone: DEV_RIDER_PHONE, name: "Dev Rider", vehicle_type: "bike", ...fields });
    rider = { id };
  }
  await db("orders").where({ id: orderId }).update({ rider_id: rider.id });
  notifyLater(() => orderPush.riderAssigned(orderId));
  return db("orders").where({ id: orderId }).first();
}

/**
 * Advance an order one step (default) or up to `to`. Returns what happened.
 * @param {number|string} orderId
 * @param {{to?: 'accepted'|'picked_up'|'on_the_way'|'delivered'}} [opts]
 */
async function advanceOrder(orderId, { to } = {}) {
  if (to && !STEP_ORDER.includes(to)) {
    throw new Error(`"to" must be one of: ${STEP_ORDER.slice(1).join(", ")}`);
  }

  const steps = [];
  const notes = [];
  for (let guard = 0; guard < STEP_ORDER.length; guard++) {
    let order = await db("orders").where({ id: orderId }).first();
    if (!order) throw new Error(`Order ${orderId} not found`);
    if (order.status === "cancelled") throw new Error(`Order ${orderId} is cancelled`);
    if (order.status === "delivered") break;
    if (to && STEP_ORDER.indexOf(order.status) >= STEP_ORDER.indexOf(to)) break;

    const from = order.status;
    const restaurantAuth = { id: order.restaurant_id, type: "restaurant" };

    if (from === "placed") {
      if (order.payment_method !== "cod" && order.payment_status !== "paid") {
        notes.push(`order is ${order.payment_method}/${order.payment_status} — accepted anyway (dev)`);
      }
      await call(orderController.acceptOrder, { params: { id: order.id }, auth: restaurantAuth });
    } else if (from === "accepted") {
      order = await ensureRider(order.id);
      await call(orderController.markPickedUp, { params: { id: order.id }, auth: { id: order.rider_id, type: "rider" } });
    } else if (from === "picked_up") {
      await call(orderController.markOnTheWay, { params: { id: order.id }, auth: { id: order.rider_id, type: "rider" } });
    } else if (from === "on_the_way") {
      // A trusted dev tool with direct DB access, so it can read the delivery
      // code itself rather than needing it typed in — a real rider can't.
      const body = { delivery_otp: order.delivery_otp, ...(order.payment_method === "cod" ? { cod_amount_collected: Number(order.grand_total) } : {}) };
      await call(orderController.markDelivered, { params: { id: order.id }, body, auth: { id: order.rider_id, type: "rider" } });
    }

    const after = await db("orders").where({ id: orderId }).first();
    steps.push(`${from} -> ${after.status}`);
    if (!to) break; // no target: exactly one step per call, so the app can be watched changing
  }

  const final = await db("orders").where({ id: orderId }).first();
  return {
    orderId: final.id,
    status: final.status,
    steps,
    notes,
    eta_minutes: final.eta_minutes,
    rider_id: final.rider_id,
    payment_status: final.payment_status,
  };
}

/** Adds dev wallet credit to a customer (by 10-digit phone) via the real ledger. */
async function addCredit(phone, amount) {
  const value = Number(amount);
  if (!phone || !/^\d{10}$/.test(String(phone))) throw new Error("phone must be a 10-digit number");
  if (!Number.isFinite(value) || value <= 0 || value > 100000) throw new Error("amount must be a number between 1 and 100000");

  const user = await db("users").where({ phone: String(phone) }).first();
  if (!user) throw new Error(`No customer with phone ${phone} — log in to the app with it first`);

  const balance = await wallet.recordEntry({
    ownerType: "customer",
    ownerId: user.id,
    entryType: "credit",
    amount: value,
    reason: "manual_adjustment",
    notes: "Dev credit",
  });
  return { phone: String(phone), added: value, balance };
}

module.exports = { advanceOrder, addCredit };
