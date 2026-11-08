const db = require("../config/db");
const wallet = require("./wallet.service");
const settlement = require("./restaurantSettlement.service");
const { parseRange, dayKey } = require("../utils/reportRange");

/**
 * A kitchen's OWN sales and payout figures (Restaurant app "Sales & Earnings"). It reads what the admin settlement already computes
 * (restaurantSettlement.service.js: payable on the delivery date, adjustments, payments) but only ever returns DAY-LEVEL AGGREGATES
 * for the one kitchen: never a per-order payable, a per-line vendor cost, a dish margin, or another kitchen's data. All days are IST
 * days (REPORT_TZ_OFFSET_MINUTES).
 *
 * Definitions:
 *  orders_received  orders assigned to this kitchen that it could see (COD, or paid/refunded online), by placement day
 *  orders_completed delivered orders, by delivery day
 *  orders_cancelled cancelled orders (not abandoned unpaid ones), by cancellation day
 *  gross_sales      Σ item_total of completed orders (the food value the kitchen already sees on each order)
 *  cancelled_value  Σ item_total of cancelled orders
 *  refunded_value   what customers were refunded for lines this kitchen dropped as unavailable at accept time, by refund day
 *  earnings         Σ restaurant payable of completed orders (the vendor-cost payable: the settlement's rule)
 *  adjustments      Σ signed adjustments an admin recorded for the kitchen (+ owed to it, − a deduction), by day
 *  net_payable      earnings + adjustments
 */

const UNPAID_REASON = "payment_not_completed"; // abandoned online orders: never real orders
const money = (n) => Number(Number(n || 0).toFixed(2));
const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Calendar helpers on "YYYY-MM-DD" strings (pure date arithmetic; the IST offset only matters when turning a day into instants)
// ---------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidDate(s) {
  const m = DATE_ONLY.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const toDate = (s) => { const m = DATE_ONLY.exec(s); return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))); };
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * DAY_MS));

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** { from, to, previous: { from, to } } (all "YYYY-MM-DD") for a day / Monday-Sunday week / calendar month containing `date`. */
function rangeFor(period, date) {
  if (period === "day") return { from: date, to: date, previous: { from: addDays(date, -1), to: addDays(date, -1) } };
  if (period === "week") {
    const dow = (toDate(date).getUTCDay() + 6) % 7; // Monday = 0
    const from = addDays(date, -dow);
    return { from, to: addDays(from, 6), previous: { from: addDays(from, -7), to: addDays(from, -1) } };
  }
  const d = toDate(date);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const monthEnd = (yy, mm) => fmt(new Date(Date.UTC(yy, mm + 1, 0)));
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return {
    from: fmt(new Date(Date.UTC(y, m, 1))), to: monthEnd(y, m),
    previous: { from: fmt(prev), to: monthEnd(prev.getUTCFullYear(), prev.getUTCMonth()) },
  };
}

/** The instants a day range covers (to = the last millisecond of that IST day). */
const instants = (from, to) => parseRange({ from, to });

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

const visibleToKitchen = (qb) => qb.where((w) => w.where("o.payment_method", "cod").orWhereIn("o.payment_status", ["paid", "refunded"]));
const notAbandoned = (qb) => qb.where((w) => w.whereNull("o.cancel_reason").orWhere("o.cancel_reason", "!=", UNPAID_REASON));

const emptyDay = (date) => ({ date, orders_received: 0, orders_completed: 0, orders_cancelled: 0, gross_sales: 0, cancelled_value: 0, refunded_value: 0, earnings: 0, adjustments: 0, net_payable: 0 });

/** One IST day's figures for [from, to] (inclusive "YYYY-MM-DD" days), oldest first, zeros included. */
async function dailyFigures(restaurantId, from, to) {
  const { from: t0, to: t1 } = instants(from, to);
  const days = new Map(eachDay(from, to).map((d) => [d, emptyDay(d)]));
  const bump = (instant, fn) => { const row = days.get(dayKey(instant)); if (row) fn(row); };

  const received = await db("orders as o").where("o.restaurant_id", restaurantId).where("o.created_at", ">=", t0).where("o.created_at", "<=", t1).modify(visibleToKitchen).modify(notAbandoned).select("o.created_at");
  received.forEach((r) => bump(r.created_at, (d) => { d.orders_received += 1; }));

  const completed = await db("orders as o").where({ "o.restaurant_id": restaurantId, "o.status": "delivered" }).where("o.delivered_at", ">=", t0).where("o.delivered_at", "<=", t1)
    .select("o.delivered_at", "o.item_total", db.raw(`${settlement.PAYABLE_SQL} as payable`));
  completed.forEach((r) => bump(r.delivered_at, (d) => { d.orders_completed += 1; d.gross_sales += Number(r.item_total); d.earnings += Number(r.payable); }));

  const cancelled = await db("orders as o").where({ "o.restaurant_id": restaurantId, "o.status": "cancelled" }).where("o.cancelled_at", ">=", t0).where("o.cancelled_at", "<=", t1).modify(notAbandoned).select("o.cancelled_at", "o.item_total");
  cancelled.forEach((r) => bump(r.cancelled_at, (d) => { d.orders_cancelled += 1; d.cancelled_value += Number(r.item_total); }));

  const refunds = await db("wallet_ledger as w").join("orders as o", "o.id", "w.related_order_id")
    .where({ "o.restaurant_id": restaurantId, "w.owner_type": "customer", "w.reason": "order_refund", "w.notes": wallet.DROPPED_ITEMS_REFUND_NOTE })
    .where("w.created_at", ">=", t0).where("w.created_at", "<=", t1).select("w.created_at", "w.amount");
  refunds.forEach((r) => bump(r.created_at, (d) => { d.refunded_value += Number(r.amount); }));

  const adjustments = await db("restaurant_adjustments").where({ restaurant_id: restaurantId }).where("created_at", ">=", t0).where("created_at", "<=", t1).select("created_at", "amount");
  adjustments.forEach((r) => bump(r.created_at, (d) => { d.adjustments += Number(r.amount); }));

  return [...days.values()].map((d) => {
    const row = { ...d };
    for (const k of ["gross_sales", "cancelled_value", "refunded_value", "earnings", "adjustments"]) row[k] = money(row[k]);
    row.net_payable = money(row.earnings + row.adjustments);
    return row;
  });
}

const SUM_KEYS = ["orders_received", "orders_completed", "orders_cancelled", "gross_sales", "cancelled_value", "refunded_value", "earnings", "adjustments"];

function summarise(days) {
  const s = Object.fromEntries(SUM_KEYS.map((k) => [k, money(days.reduce((acc, d) => acc + d[k], 0))]));
  s.net_payable = money(s.earnings + s.adjustments);
  for (const k of ["orders_received", "orders_completed", "orders_cancelled"]) s[k] = Math.round(s[k]);
  return s;
}

/** The whole GET /restaurants/me/sales answer. `period` day|week|month and `date` ("YYYY-MM-DD", IST) are already validated. */
async function salesReport(restaurantId, period, date) {
  const range = rangeFor(period, date);
  const [days, prevDays] = await Promise.all([dailyFigures(restaurantId, range.from, range.to), dailyFigures(restaurantId, range.previous.from, range.previous.to)]);
  return {
    period, date, range: { from: range.from, to: range.to }, previous_range: range.previous,
    summary: summarise(days), previous: summarise(prevDays), days,
  };
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/** The all-time payout position of one kitchen. */
async function payoutSummary(restaurantId) {
  const [sales, earnedMap, adj, paid, last] = await Promise.all([
    db("orders").where({ restaurant_id: restaurantId, status: "delivered" }).sum({ s: "item_total" }).first(),
    settlement.earnedByRestaurant({ restaurantId }),
    db("restaurant_adjustments").where({ restaurant_id: restaurantId }).sum({ s: "amount" }).first(),
    db("restaurant_payments").where({ restaurant_id: restaurantId }).sum({ s: "amount" }).first(),
    db("restaurant_payments").where({ restaurant_id: restaurantId }).max({ last: "paid_at" }).first(),
  ]);
  const totalEarned = money(earnedMap[restaurantId]?.payable || 0);
  const totalAdjustments = money(adj.s);
  const totalPaid = money(paid.s);
  const totalPayable = money(totalEarned + totalAdjustments);
  const pending = money(totalPayable - totalPaid);
  return {
    total_sales: money(sales.s), total_earned: totalEarned, total_adjustments: totalAdjustments, total_payable: totalPayable,
    total_paid: totalPaid, pending, status: settlement.statusOf(pending), last_payment_at: last.last || null,
  };
}

async function payoutsPage(restaurantId, { page, limit }) {
  const offset = (page - 1) * limit;
  const [summary, payments, adjustments, pTotal, aTotal] = await Promise.all([
    payoutSummary(restaurantId),
    db("restaurant_payments").where({ restaurant_id: restaurantId }).orderBy("paid_at", "desc").orderBy("id", "desc").limit(limit).offset(offset),
    db("restaurant_adjustments").where({ restaurant_id: restaurantId }).orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).offset(offset),
    db("restaurant_payments").where({ restaurant_id: restaurantId }).count({ n: "*" }).first(),
    db("restaurant_adjustments").where({ restaurant_id: restaurantId }).count({ n: "*" }).first(),
  ]);
  return {
    summary,
    payments: payments.map((p) => ({ id: p.id, paid_at: p.paid_at, amount: Number(p.amount), method: p.method, reference: p.reference, notes: p.notes, status: "paid" })),
    adjustments: adjustments.map((a) => ({ id: a.id, created_at: a.created_at, amount: Number(a.amount), reason: a.reason, order_id: a.related_order_id })),
    page, limit, total: Number(pTotal.n), adjustments_total: Number(aTotal.n),
  };
}

// ---------------------------------------------------------------------------
// Ledger / settlement statement (a running balance; day-level only)
// ---------------------------------------------------------------------------

/**
 * Events in a window, with a running balance. The window is (lower, upper] — or [lower, upper] when lowerInclusive — and lower may be
 * null (from the beginning). `onlyPayment` restricts the payments to that one row (a settlement statement). Orders are collapsed into
 * ONE row per delivery day ("3 orders delivered"), so no per-order payable ever appears.
 */
async function ledger(restaurantId, { lower, lowerInclusive = true, upper, onlyPayment = null }) {
  const after = (col) => (qb) => {
    if (lower) qb.where(col, lowerInclusive ? ">=" : ">", lower);
    qb.where(col, "<=", upper);
  };
  const before = (col) => (qb) => { qb.where(col, lowerInclusive ? "<" : "<=", lower); };

  let opening = 0;
  if (lower) {
    const [e, a, p] = await Promise.all([
      db("orders as o").where({ "o.restaurant_id": restaurantId, "o.status": "delivered" }).modify(before("o.delivered_at")).select(db.raw(`COALESCE(SUM(${settlement.PAYABLE_SQL}), 0) as s`)).first(),
      db("restaurant_adjustments").where({ restaurant_id: restaurantId }).modify(before("created_at")).sum({ s: "amount" }).first(),
      db("restaurant_payments").where({ restaurant_id: restaurantId }).modify(before("paid_at")).sum({ s: "amount" }).first(),
    ]);
    opening = money(Number(e.s || 0) + Number(a.s || 0) - Number(p.s || 0));
  }

  const orders = await db("orders as o").where({ "o.restaurant_id": restaurantId, "o.status": "delivered" }).modify(after("o.delivered_at")).select("o.delivered_at", db.raw(`${settlement.PAYABLE_SQL} as payable`));
  const perDay = new Map();
  for (const o of orders) {
    const k = dayKey(o.delivered_at);
    const d = perDay.get(k) || { count: 0, earned: 0 };
    d.count += 1; d.earned += Number(o.payable);
    perDay.set(k, d);
  }
  const adjustments = await db("restaurant_adjustments").where({ restaurant_id: restaurantId }).modify(after("created_at")).orderBy("created_at", "asc").orderBy("id", "asc");
  const payments = onlyPayment
    ? [onlyPayment]
    : await db("restaurant_payments").where({ restaurant_id: restaurantId }).modify(after("paid_at")).orderBy("paid_at", "asc").orderBy("id", "asc");

  const events = [];
  for (const [date, d] of perDay) events.push({ date, order: 0, type: "orders", description: `${d.count} order${d.count === 1 ? "" : "s"} delivered`, credit: money(d.earned), debit: 0 });
  for (const a of adjustments) {
    const amt = Number(a.amount);
    events.push({ date: dayKey(a.created_at), order: 1, id: a.id, type: "adjustment", description: a.reason || "Adjustment", credit: amt > 0 ? money(amt) : 0, debit: amt < 0 ? money(-amt) : 0 });
  }
  for (const p of payments) {
    events.push({ date: dayKey(p.paid_at), order: 2, id: p.id, type: "payment", description: `Payment${p.reference ? ` · ${p.reference}` : ""}${p.method ? ` (${String(p.method).replace("_", " ")})` : ""}`, credit: 0, debit: money(Number(p.amount)) });
  }
  events.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.order - y.order || (x.id || 0) - (y.id || 0)));

  let balance = opening;
  const rows = events.map(({ date, type, description, credit, debit }) => { balance = money(balance + credit - debit); return { date, type, description, credit, debit, balance }; });
  const earned = money(rows.filter((r) => r.type === "orders").reduce((s, r) => s + r.credit, 0));
  const adj = money(adjustments.reduce((s, a) => s + Number(a.amount), 0));
  const paid = money(payments.reduce((s, p) => s + Number(p.amount), 0));
  return { opening_balance: opening, earned, adjustments: adj, paid, closing_balance: money(opening + earned + adj - paid), rows };
}

/** Ledger for [from, to] ("YYYY-MM-DD" IST days). */
async function ledgerReport(restaurantId, from, to) {
  const r = instants(from, to);
  return { from, to, ...(await ledger(restaurantId, { lower: r.from, lowerInclusive: true, upper: r.to })) };
}

/** The statement for one payment: everything since the previous payment up to this one. null if the payment isn't this kitchen's. */
async function settlementStatement(restaurantId, paymentId) {
  const id = Number(paymentId);
  if (!Number.isInteger(id)) return null;
  const payment = await db("restaurant_payments").where({ id, restaurant_id: restaurantId }).first();
  if (!payment) return null;
  const prev = await db("restaurant_payments").where({ restaurant_id: restaurantId })
    .where((w) => w.where("paid_at", "<", payment.paid_at).orWhere((x) => x.where("paid_at", payment.paid_at).where("id", "<", payment.id)))
    .orderBy("paid_at", "desc").orderBy("id", "desc").first();
  const l = await ledger(restaurantId, { lower: prev ? prev.paid_at : null, lowerInclusive: false, upper: payment.paid_at, onlyPayment: payment });
  return {
    payment: { id: payment.id, paid_at: payment.paid_at, amount: Number(payment.amount), method: payment.method, reference: payment.reference, notes: payment.notes },
    previous_payment_at: prev ? prev.paid_at : null, ...l,
  };
}

async function kitchenName(restaurantId) {
  const r = await db("restaurants").where({ id: restaurantId }).select("name").first();
  return r ? r.name : "Kitchen";
}

module.exports = {
  isValidDate, addDays, eachDay, rangeFor, dailyFigures, summarise, salesReport, payoutSummary, payoutsPage, ledgerReport, settlementStatement, kitchenName, money,
};
