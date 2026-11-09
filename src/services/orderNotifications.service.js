// What each order event tells whom. Wording lives here so the controllers only
// say *that* something happened (via push.notifyLater).
//
// Customer pushes never name the kitchen (CLAUDE.md: restaurant identity is
// never shown to the customer); rider pushes may, since riders need the pickup.
const db = require("../config/db");
const push = require("./push.service");
const riderPay = require("./riderPay.service");
const routeDistance = require("./routeDistance.service");
const sendToOwner = (...args) => push.sendToOwner(...args); // looked up per call so a test can spy on the push

const rupees = (amount) => `₹${Number(amount).toFixed(2).replace(/\.00$/, "")}`;

// "Bengali" or "Bengali + Chinese (Indo)" for a clubbed order.
async function categoryLabel(orderId) {
  const rows = await db("order_items")
    .join("categories", "categories.id", "order_items.category_id")
    .where({ "order_items.order_id": orderId, "order_items.status": "confirmed" })
    .distinct("categories.name")
    .pluck("categories.name");
  return rows.join(" + ");
}

function toCustomer(order, title, body) {
  return sendToOwner("customer", order.customer_id, { title, body, data: { type: "order_update", orderId: order.id } });
}

async function load(orderId) {
  return db("orders").where({ id: orderId }).first();
}

/** Restaurant accepted. refundAmount > 0 when items were dropped from a paid order. */
async function orderAccepted(orderId, refundAmount = 0) {
  const order = await load(orderId);
  const label = await categoryLabel(orderId);
  let body = `Your ${label || "food"} order is being prepared.`;
  if (refundAmount > 0) body += ` Some items were unavailable, so ${rupees(refundAmount)} was refunded to your wallet.`;
  await toCustomer(order, "Order confirmed", body);
}

async function orderPickedUp(orderId) {
  const order = await load(orderId);
  const eta = order.eta_minutes ? ` Arriving in about ${order.eta_minutes} min.` : "";
  await toCustomer(order, "Out for delivery", `Your rider has picked up your order.${eta}`);
}

async function orderOnTheWay(orderId) {
  const order = await load(orderId);
  await toCustomer(order, "On the way", "Your order is almost there.");
}

async function orderDelivered(orderId) {
  const order = await load(orderId);
  await toCustomer(order, "Delivered", "Enjoy your meal! Rate your order in the app.");
}

/** Cancelled by the platform (no kitchen could take it), not by the customer. */
async function orderCancelledBySystem(orderId) {
  const order = await load(orderId);
  const refund = order.payment_status === "refunded" ? ` ${rupees(order.grand_total)} has been refunded to your wallet.` : "";
  await toCustomer(order, "Order cancelled", `Sorry, no kitchen nearby could take your order right now.${refund}`);
}

/**
 * The order is now in this kitchen's queue. Only call once the kitchen can see
 * it — restaurants only see paid or COD orders.
 */
async function newOrderForRestaurant(orderId, { reminder = false } = {}) {
  const order = await load(orderId);
  if (!order) return;
  if (!reminder) {
    // First push for the current kitchen. (Re-routing to another kitchen resets this in rejectOrder, so it is stamped afresh.)
    await db("orders").where({ id: orderId }).whereNull("kitchen_notified_at").update({ kitchen_notified_at: new Date() });
  }
  const { count } = await db("order_items")
    .where({ order_id: orderId, status: "confirmed" })
    .sum({ count: "quantity" })
    .first();
  const items = Number(count) === 1 ? "1 item" : `${Number(count) || 0} items`;
  const pay = order.payment_method === "cod" ? " (Cash on delivery)" : "";
  await sendToOwner("restaurant", order.restaurant_id, {
    title: reminder ? "Reminder: order waiting" : "New order received!",
    body: `Fengle Order #${order.id} · ${items} · ${rupees(order.grand_total)}${pay}. Tap to view and accept.`,
    data: { type: reminder ? "new_order_reminder" : "new_order", orderId: order.id },
    // The siren channel the Restaurant app creates; one notification per order (each reminder replaces the last and re-alerts).
    alert: { channelId: "new-orders", tag: `order-${order.id}` },
  });
}

/**
 * The end of an address, at a word boundary: roughly "the area" the rider needs in a notification (the start of an Indian address is
 * the house / flat, the end is the locality, city and pin).
 */
function shortArea(address, max = 40) {
  const s = String(address || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const tail = s.slice(-max);
  const cut = tail.indexOf(" ");
  return `…${(cut >= 0 && cut < max - 8 ? tail.slice(cut + 1) : tail).trim()}`;
}

/**
 * An order was assigned to this rider (and ONLY this rider — never a broadcast). The loud "new-deliveries" alert with what the rider
 * needs to decide at a glance: pickup kitchen (riders may see it, customers never), the drop area, the distance and the estimated pay.
 * `reminder` re-sends the same alert (same tag, so it replaces the last one) while the rider hasn't reacted.
 */
async function riderAssigned(orderId, { reminder = false } = {}) {
  const order = await load(orderId);
  if (!order || !order.rider_id) return;
  if (!reminder) {
    // First push for the current rider (a different rider resets this where the assignment is made).
    await db("orders").where({ id: orderId }).whereNull("rider_notified_at").update({ rider_notified_at: new Date() });
  }
  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).select("name", "address", "lat", "lng", "radius_km", "commission_rate_percent").first();
  const route = restaurant ? await routeDistance.ensureForOrder(order, restaurant) : null; // the order's one road distance (straight line when no Routes API key)
  const km = route ? route.distance_km : null;
  const payout = restaurant ? await riderPay.estimatePayout({ order, restaurant }) : null;
  const pickupArea = restaurant ? shortArea(restaurant.address) : "";
  const cod = order.payment_method === "cod" ? ` Collect ${rupees(order.grand_total)} cash.` : "";
  const figures = [km != null && Number.isFinite(km) ? `${km.toFixed(1)} km` : null, payout != null ? rupees(payout) : null].filter(Boolean).join(" · ");
  await sendToOwner("rider", order.rider_id, {
    title: reminder ? "Reminder: delivery waiting" : "New delivery request",
    body: `Order #${order.id} · Pickup: ${restaurant ? restaurant.name : "the kitchen"}${pickupArea ? `, ${pickupArea}` : ""}. Drop: ${shortArea(order.delivery_address) || "see the order"}.${figures ? ` ${figures}` : ""}${cod}`,
    data: { type: reminder ? "new_delivery_reminder" : "new_delivery", orderId: order.id },
    // The siren channel the Rider app creates; one notification per delivery (each reminder replaces the last and re-alerts).
    alert: { channelId: "new-deliveries", tag: `delivery-${order.id}` },
  });
}

/** The assigned rider reached the kitchen: tell the kitchen (a normal push, not the alarm). */
async function riderArrived(orderId) {
  const order = await load(orderId);
  if (!order) return;
  await sendToOwner("restaurant", order.restaurant_id, {
    title: `Rider has arrived for order #${order.id}`, body: "The delivery partner is at your kitchen to pick it up.",
    data: { type: "rider_arrived", orderId: order.id },
  });
}

/** Restaurants only see paid or COD orders, so only then is it "new" to them. */
function isVisibleToRestaurant(order) {
  return order.payment_method === "cod" || order.payment_status === "paid";
}

module.exports = {
  orderAccepted,
  orderPickedUp,
  orderOnTheWay,
  orderDelivered,
  orderCancelledBySystem,
  newOrderForRestaurant,
  riderAssigned,
  riderArrived,
  shortArea,
  isVisibleToRestaurant,
};
