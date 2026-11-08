// What each order event tells whom. Wording lives here so the controllers only
// say *that* something happened (via push.notifyLater).
//
// Customer pushes never name the kitchen (CLAUDE.md: restaurant identity is
// never shown to the customer); rider pushes may, since riders need the pickup.
const db = require("../config/db");
const push = require("./push.service");
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

async function riderAssigned(orderId) {
  const order = await load(orderId);
  if (!order.rider_id) return;
  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).select("name").first();
  const cod = order.payment_method === "cod" ? ` Collect ${rupees(order.grand_total)} cash.` : "";
  await sendToOwner("rider", order.rider_id, {
    title: `New delivery #${order.id}`,
    body: `Pick up from ${restaurant ? restaurant.name : "the kitchen"}.${cod}`,
    data: { type: "new_delivery", orderId: order.id },
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
  isVisibleToRestaurant,
};
