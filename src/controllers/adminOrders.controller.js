const db = require("../config/db");
const wallet = require("../services/wallet.service");
const { paginationParams } = require("../utils/pagination");
const { scrubDeliveryOtp } = require("./order.controller");

const ORDER_STATUSES = ["placed", "accepted", "picked_up", "on_the_way", "delivered", "cancelled"];
const PAYMENT_METHODS = ["upi", "card", "netbanking", "cod", "wallet"];

/**
 * GET /admin/orders?page=&limit=&status=&q=&restaurant_id=&rider_id=&from=&to=&payment_method=
 * `q` matches the order id (if numeric) or a customer phone substring.
 * `from`/`to` filter on created_at (inclusive), ISO dates.
 */
async function listOrders(req, res) {
  const { status, q, restaurant_id, rider_id, from, to, payment_method } = req.query;
  if (status && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
  }
  if (payment_method && !PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(", ")}` });
  }
  const { page, limit, offset } = paginationParams(req);

  let base = db("orders")
    .join("users", "users.id", "orders.customer_id")
    .leftJoin("restaurants", "restaurants.id", "orders.restaurant_id")
    .leftJoin("riders", "riders.id", "orders.rider_id");

  if (status) base = base.where("orders.status", status);
  if (payment_method) base = base.where("orders.payment_method", payment_method);
  if (restaurant_id) base = base.where("orders.restaurant_id", restaurant_id);
  if (rider_id) base = base.where("orders.rider_id", rider_id);
  if (from) base = base.where("orders.created_at", ">=", new Date(from));
  if (to) base = base.where("orders.created_at", "<=", new Date(to));
  if (q && q.trim()) {
    const term = q.trim();
    base = base.andWhere((qb) => {
      qb.where("users.phone", "like", `%${term}%`);
      if (/^\d+$/.test(term)) qb.orWhere("orders.id", Number(term));
    });
  }

  const { n: total } = await base.clone().count({ n: "orders.id" }).first();

  const rows = await base
    .clone()
    .orderBy("orders.created_at", "desc")
    .limit(limit)
    .offset(offset)
    .select(
      "orders.id", "orders.status", "orders.payment_method", "orders.payment_status", "orders.grand_total", "orders.created_at",
      "users.id as customer_id", "users.name as customer_name", "users.phone as customer_phone",
      "restaurants.id as restaurant_id", "restaurants.name as restaurant_name",
      "riders.id as rider_id", "riders.name as rider_name"
    );

  // Category name(s) + item count per order — a second batched query rather
  // than joining order_items into the paginated one, which would fan out rows
  // and break both the pagination and the COUNT(*) above.
  const orderIds = rows.map((r) => r.id);
  const itemRows = orderIds.length
    ? await db("order_items")
        .join("categories", "categories.id", "order_items.category_id")
        .whereIn("order_items.order_id", orderIds)
        .select("order_items.order_id", "categories.name as category_name")
    : [];
  const categoryNamesByOrder = {};
  const itemCountByOrder = {};
  for (const row of itemRows) {
    itemCountByOrder[row.order_id] = (itemCountByOrder[row.order_id] || 0) + 1;
    (categoryNamesByOrder[row.order_id] ||= new Set()).add(row.category_name);
  }

  res.json({
    orders: rows.map((r) => ({
      ...r,
      category_names: [...(categoryNamesByOrder[r.id] || [])],
      item_count: itemCountByOrder[r.id] || 0,
    })),
    page,
    limit,
    total: Number(total),
  });
}

/**
 * GET /admin/orders/:id — full admin detail: parties, items, the money
 * breakdown, every status timestamp, ratings, and this order's wallet_ledger
 * rows — as sibling keys next to `order` (confirmed shape, matches what the
 * Admin Panel already tested against). Deliberately a separate response
 * shape from the shared GET /orders/:id (used by customer/restaurant/rider)
 * rather than overloading it — this one always shows restaurant+customer
 * together, which that endpoint must never do. `delivery_otp` is never
 * returned (same rule as every non-customer reader). There is no
 * `accepted_at`/`on_the_way_at` on orders yet (known gap — only
 * picked_up_at/delivered_at/cancelled_at exist).
 */
async function getOrder(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });

  const customer = await db("users").where({ id: order.customer_id }).select("id", "name", "phone", "email", "status").first();
  const restaurant = order.restaurant_id
    ? await db("restaurants").where({ id: order.restaurant_id }).select("id", "name", "phone", "address", "status").first()
    : null;
  const rider = order.rider_id
    ? await db("riders").where({ id: order.rider_id }).select("id", "name", "phone", "status").first()
    : null;
  const items = await db("order_items")
    .leftJoin("items", "items.id", "order_items.item_id")
    .join("categories", "categories.id", "order_items.category_id")
    .where("order_items.order_id", id)
    .orderBy("order_items.id")
    .select("order_items.*", db.raw("COALESCE(order_items.item_name, items.name) as name"), "categories.name as category_name");
  const walletLedger = await db("wallet_ledger").where({ related_order_id: id }).orderBy("created_at", "asc");

  const { delivery_otp, ...safeOrder } = order;

  res.json({ order: safeOrder, customer, restaurant, rider, items, wallet_ledger: walletLedger });
}

/**
 * Order rows for a given owner (rider_id or customer_id), in the exact same
 * shape as GET /admin/orders' list rows (with restaurant_name/rider_name/
 * category_names/item_count) and — critically — never selecting
 * delivery_otp. Shared by admin.controller.js's rider detail and
 * adminCustomers.controller.js's customer detail so neither has to
 * `select("*")` on orders (which would leak the OTP) or duplicate this join.
 */
async function listOrdersForOwner(column, ownerId, limit = 200) {
  const rows = await db("orders")
    .leftJoin("restaurants", "restaurants.id", "orders.restaurant_id")
    .leftJoin("riders", "riders.id", "orders.rider_id")
    .where(`orders.${column}`, ownerId)
    .orderBy("orders.created_at", "desc")
    .limit(limit)
    .select(
      "orders.id", "orders.customer_id", "orders.restaurant_id", "orders.rider_id",
      "orders.status", "orders.payment_method", "orders.payment_status", "orders.grand_total", "orders.created_at",
      "restaurants.name as restaurant_name", "riders.name as rider_name"
    );

  const orderIds = rows.map((r) => r.id);
  const itemRows = orderIds.length
    ? await db("order_items").join("categories", "categories.id", "order_items.category_id").whereIn("order_items.order_id", orderIds).select("order_items.order_id", "categories.name as category_name")
    : [];
  const categoryNamesByOrder = {};
  const itemCountByOrder = {};
  for (const row of itemRows) {
    itemCountByOrder[row.order_id] = (itemCountByOrder[row.order_id] || 0) + 1;
    (categoryNamesByOrder[row.order_id] ||= new Set()).add(row.category_name);
  }
  return rows.map((r) => ({ ...r, category_names: [...(categoryNamesByOrder[r.id] || [])], item_count: itemCountByOrder[r.id] || 0 }));
}

/**
 * POST /admin/orders/:id/cancel  body: { reason? }
 * Admin override — cancellable at any status before delivered/cancelled,
 * bypassing the customer's own buffer-window rule (that's a customer-UX
 * limit, not a platform one). Refunds to the customer's wallet if already
 * paid, same as every other cancellation path.
 */
async function cancelOrder(req, res) {
  const { id } = req.params;
  const { reason } = req.body || {};
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (["delivered", "cancelled"].includes(order.status)) {
    return res.status(409).json({ error: `Order is already ${order.status}` });
  }

  await db.transaction(async (trx) => {
    await trx("orders").where({ id }).update({
      status: "cancelled",
      cancelled_at: new Date(),
      cancel_reason: reason || null,
      cancelled_by: "admin",
    });
    if (order.payment_status === "paid") {
      await wallet.recordCustomerRefund(order.customer_id, order.id, Number(order.grand_total), reason ? `Admin cancellation: ${reason}` : "Admin cancellation", trx);
      await trx("orders").where({ id }).update({ payment_status: "refunded" });
    }
    await trx("coupon_redemptions").where({ order_id: id }).delete();
  });

  res.json({ order: scrubDeliveryOtp(await db("orders").where({ id }).first(), "admin") });
}

/**
 * POST /admin/orders/:id/reassign-rider  body: { rider_id }
 * Manual override for when the auto-assigned rider can't continue. Only
 * while the order is actively out for delivery; the new rider must be active.
 */
async function reassignRider(req, res) {
  const { id } = req.params;
  const { rider_id } = req.body || {};
  if (!rider_id) return res.status(400).json({ error: "rider_id is required" });

  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!["accepted", "picked_up", "on_the_way"].includes(order.status)) {
    return res.status(409).json({ error: `Cannot reassign a rider for an order in status '${order.status}'` });
  }

  const rider = await db("riders").where({ id: rider_id }).first();
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  if (rider.status !== "active") return res.status(400).json({ error: "Rider must be active to be assigned" });

  await db("orders").where({ id }).update({ rider_id });
  res.json({ order: scrubDeliveryOtp(await db("orders").where({ id }).first(), "admin") });
}

module.exports = { listOrders, getOrder, cancelOrder, reassignRider, listOrdersForOwner };
