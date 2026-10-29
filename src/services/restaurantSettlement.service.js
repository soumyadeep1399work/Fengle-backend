const db = require("../config/db");
const { dayKey } = require("../utils/reportRange");

const EPS = 0.005;
const money = (n) => Number(Number(n).toFixed(2));
const SETTLED = "settled";

/**
 * How Fengle pays kitchens: no commission cycle. Each delivered order earns the kitchen its
 * `restaurant_payable` (vendor cost x quantity over the confirmed lines); admins record payments
 * whenever they pay, and signed adjustments for anything agreed off-system.
 *
 *   outstanding = total_payable + total_adjustments - total_paid      (all time; negative = paid in advance)
 *   status      = "settled" when outstanding is 0, "advance" when negative, otherwise "due"
 *
 * A payable is earned on the order's DELIVERY date (when the kitchen did the work). Orders that predate the
 * vendor-cost model carry an estimated payable (the old commission formula) and are flagged `estimated`.
 */

// Delivered orders' payable and flag; an order somehow without a stored payable falls back to the old formula (estimated).
const PAYABLE_SQL = "COALESCE(o.restaurant_payable, o.item_total - o.commission_amount)";
const ESTIMATED_SQL = "(CASE WHEN o.restaurant_payable IS NULL OR o.payable_estimated = 1 THEN 1 ELSE 0 END)";

const statusOf = (outstanding) => (Math.abs(outstanding) < EPS ? SETTLED : outstanding < 0 ? "advance" : "due");

function between(qb, column, from, to) {
  if (from) qb.where(column, ">=", from);
  if (to) qb.where(column, "<=", to);
  return qb;
}

/** { [restaurantId]: { orders, payable, estimated } } for delivered orders delivered in [from, to] (either bound optional). */
async function earnedByRestaurant({ from, to, restaurantId, before } = {}) {
  let q = db("orders as o").where("o.status", "delivered").whereNotNull("o.restaurant_id")
    .select("o.restaurant_id")
    .select(db.raw("COUNT(*) as orders"), db.raw(`COALESCE(SUM(${PAYABLE_SQL}), 0) as payable`), db.raw(`COALESCE(SUM(${ESTIMATED_SQL}), 0) as estimated`))
    .groupBy("o.restaurant_id");
  if (before) q = q.where("o.delivered_at", "<", before);
  else q = between(q, "o.delivered_at", from, to);
  if (restaurantId) q = q.where("o.restaurant_id", restaurantId);
  return Object.fromEntries((await q).map((r) => [r.restaurant_id, { orders: Number(r.orders), payable: Number(r.payable), estimated: Number(r.estimated) }]));
}

async function sumByRestaurant(table, amountCol, dateCol, { from, to, restaurantId, before } = {}) {
  let q = db(table).select("restaurant_id").sum({ s: amountCol }).groupBy("restaurant_id");
  if (before) q = q.where(dateCol, "<", before);
  else q = between(q, dateCol, from, to);
  if (restaurantId) q = q.where("restaurant_id", restaurantId);
  return Object.fromEntries((await q).map((r) => [r.restaurant_id, Number(r.s)]));
}

/** One row per kitchen: range figures plus all-time running totals. */
async function settlementOverview({ from, to }) {
  const [restaurants, earnedRange, earnedAll, adjRange, adjAll, paidRange, paidAll, lastPaid] = await Promise.all([
    db("restaurants").select("id", "name", "phone", "status").orderBy("name"),
    earnedByRestaurant({ from, to }),
    earnedByRestaurant({}),
    sumByRestaurant("restaurant_adjustments", "amount", "created_at", { from, to }),
    sumByRestaurant("restaurant_adjustments", "amount", "created_at", {}),
    sumByRestaurant("restaurant_payments", "amount", "paid_at", { from, to }),
    sumByRestaurant("restaurant_payments", "amount", "paid_at", {}),
    db("restaurant_payments").select("restaurant_id").max({ last: "paid_at" }).groupBy("restaurant_id"),
  ]);
  const lastById = Object.fromEntries(lastPaid.map((r) => [r.restaurant_id, r.last]));

  const rows = restaurants.map((r) => {
    const totalPayable = money(earnedAll[r.id]?.payable || 0);
    const totalAdjustments = money(adjAll[r.id] || 0);
    const totalPaid = money(paidAll[r.id] || 0);
    const outstanding = money(totalPayable + totalAdjustments - totalPaid);
    return {
      restaurant_id: r.id, restaurant_name: r.name, restaurant_phone: r.phone, restaurant_status: r.status,
      delivered_orders: earnedRange[r.id]?.orders || 0,
      payable_earned: money(earnedRange[r.id]?.payable || 0),
      adjustments: money(adjRange[r.id] || 0),
      paid: money(paidRange[r.id] || 0),
      total_payable: totalPayable, total_adjustments: totalAdjustments, total_paid: totalPaid, outstanding,
      status: statusOf(outstanding),
      estimated_orders: earnedRange[r.id]?.estimated || 0,
      estimated_orders_total: earnedAll[r.id]?.estimated || 0,
      has_estimated_payables: (earnedAll[r.id]?.estimated || 0) > 0,
      last_payment_at: lastById[r.id] || null,
    };
  }).sort((a, b) => b.outstanding - a.outstanding || a.restaurant_id - b.restaurant_id);

  const sum = (key) => money(rows.reduce((s, r) => s + r[key], 0));
  const totals = {
    delivered_orders: rows.reduce((s, r) => s + r.delivered_orders, 0),
    payable_earned: sum("payable_earned"), adjustments: sum("adjustments"), paid: sum("paid"),
    total_payable: sum("total_payable"), total_adjustments: sum("total_adjustments"), total_paid: sum("total_paid"), outstanding: sum("outstanding"),
    kitchens_due: rows.filter((r) => r.status === "due").length,
    estimated_orders_total: rows.reduce((s, r) => s + r.estimated_orders_total, 0),
  };
  return { rows, totals };
}

/**
 * A kitchen's statement for [from, to]: opening balance, every delivered order in the range with its lines
 * (vendor cost x quantity), payments and adjustments in the range, date-wise subtotals, closing balance.
 * Orders are paged by the caller; everything else covers the whole range.
 */
async function buildStatement({ restaurantId, from, to }) {
  const restaurant = await db("restaurants").where({ id: restaurantId }).select("id", "name", "phone", "status", "commission_rate_percent").first();
  if (!restaurant) return null;

  let orderQ = db("orders as o").where({ "o.restaurant_id": restaurantId, "o.status": "delivered" })
    .select("o.id", "o.delivered_at", "o.item_total", "o.coupon_discount_amount", "o.grand_total", db.raw(`${PAYABLE_SQL} as payable`), db.raw(`${ESTIMATED_SQL} as estimated`))
    .orderBy("o.delivered_at", "asc").orderBy("o.id", "asc");
  orderQ = between(orderQ, "o.delivered_at", from, to);
  const orders = await orderQ;

  const lineRows = orders.length
    ? await db("order_items").whereIn("order_id", orders.map((o) => o.id)).andWhere("status", "confirmed")
        .select("order_id", "item_id", "item_name", "quantity", "unit_price", "subtotal", "vendor_cost").orderBy("id")
    : [];
  const rate = Number(restaurant.commission_rate_percent || 0);
  const linesByOrder = {};
  for (const l of lineRows) {
    const hasCost = l.vendor_cost != null;
    const lineCost = hasCost ? money(Number(l.vendor_cost) * l.quantity) : money(Number(l.subtotal) - (Number(l.subtotal) * rate) / 100);
    (linesByOrder[l.order_id] ||= []).push({
      item_id: l.item_id, name: l.item_name, quantity: l.quantity,
      unit_price: Number(l.unit_price), line_subtotal: Number(l.subtotal),
      vendor_cost: hasCost ? Number(l.vendor_cost) : null, line_cost: lineCost, estimated: !hasCost,
    });
  }
  const orderRows = orders.map((o) => ({
    order_id: o.id, delivered_at: o.delivered_at, payable: money(o.payable), estimated: Boolean(Number(o.estimated)),
    customer_paid_items: Number(o.item_total), items: linesByOrder[o.id] || [],
  }));

  const payments = await between(db("restaurant_payments").where({ restaurant_id: restaurantId }).orderBy("paid_at", "asc").orderBy("id", "asc"), "paid_at", from, to);
  const adjustments = await between(db("restaurant_adjustments").where({ restaurant_id: restaurantId }).orderBy("created_at", "asc").orderBy("id", "asc"), "created_at", from, to);

  let opening = 0;
  if (from) {
    const [e, p, a] = await Promise.all([
      earnedByRestaurant({ restaurantId, before: from }),
      sumByRestaurant("restaurant_payments", "amount", "paid_at", { restaurantId, before: from }),
      sumByRestaurant("restaurant_adjustments", "amount", "created_at", { restaurantId, before: from }),
    ]);
    opening = money((e[restaurantId]?.payable || 0) + (a[restaurantId] || 0) - (p[restaurantId] || 0));
  }

  const earned = money(orderRows.reduce((s, o) => s + o.payable, 0));
  const adjTotal = money(adjustments.reduce((s, a) => s + Number(a.amount), 0));
  const paidTotal = money(payments.reduce((s, p) => s + Number(p.amount), 0));
  const closing = money(opening + earned + adjTotal - paidTotal);

  const days = new Map();
  for (const o of orderRows) {
    const key = dayKey(o.delivered_at);
    const d = days.get(key) || { date: key, orders: 0, payable: 0, estimated_orders: 0 };
    d.orders += 1; d.payable = money(d.payable + o.payable); d.estimated_orders += o.estimated ? 1 : 0;
    days.set(key, d);
  }

  const [e2, p2, a2] = await Promise.all([
    earnedByRestaurant({ restaurantId }),
    sumByRestaurant("restaurant_payments", "amount", "paid_at", { restaurantId }),
    sumByRestaurant("restaurant_adjustments", "amount", "created_at", { restaurantId }),
  ]);
  const outstandingNow = money((e2[restaurantId]?.payable || 0) + (a2[restaurantId] || 0) - (p2[restaurantId] || 0));

  return {
    restaurant: { id: restaurant.id, name: restaurant.name, phone: restaurant.phone, status: restaurant.status },
    opening_balance: opening, payable_earned: earned, adjustments_total: adjTotal, paid_total: paidTotal, closing_balance: closing,
    outstanding_now: outstandingNow, status: statusOf(outstandingNow), estimated_orders: orderRows.filter((o) => o.estimated).length,
    days: [...days.values()], orders: orderRows,
    payments: payments.map(presentPayment), adjustments: adjustments.map(presentAdjustment),
  };
}

const presentPayment = (r) => ({ id: r.id, restaurant_id: r.restaurant_id, amount: Number(r.amount), paid_at: r.paid_at, reference: r.reference, method: r.method, notes: r.notes, recorded_by_admin_id: r.recorded_by_admin_id, recorded_by_admin_name: r.recorded_by_admin_name ?? undefined, created_at: r.created_at });
const presentAdjustment = (r) => ({ id: r.id, restaurant_id: r.restaurant_id, amount: Number(r.amount), reason: r.reason, related_order_id: r.related_order_id, created_by_admin_id: r.created_by_admin_id, created_by_admin_name: r.created_by_admin_name ?? undefined, created_at: r.created_at });

/** Current outstanding for one kitchen (all time). */
async function outstandingFor(conn, restaurantId) {
  const earned = await conn("orders as o").where({ "o.restaurant_id": restaurantId, "o.status": "delivered" }).select(db.raw(`COALESCE(SUM(${PAYABLE_SQL}), 0) as s`)).first();
  const adj = await conn("restaurant_adjustments").where({ restaurant_id: restaurantId }).sum({ s: "amount" }).first();
  const paid = await conn("restaurant_payments").where({ restaurant_id: restaurantId }).sum({ s: "amount" }).first();
  return money(Number(earned.s || 0) + Number(adj.s || 0) - Number(paid.s || 0));
}

module.exports = { settlementOverview, buildStatement, outstandingFor, earnedByRestaurant, statusOf, presentPayment, presentAdjustment, PAYABLE_SQL, ESTIMATED_SQL, EPS };
