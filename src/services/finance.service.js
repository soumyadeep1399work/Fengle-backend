const db = require("../config/db");
const riderPay = require("./riderPay.service");
const { dayKey, monthKey } = require("../utils/reportRange");

// Online-paid = money went through the payment gateway. COD and wallet payments carry no gateway fee.
const ONLINE_METHODS = ["upi", "card", "netbanking"];
const EXPENSE_CATEGORIES = ["marketing", "operating", "salaries", "other"];

const money = (n) => Number(Number(n).toFixed(2));
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

function gatewayFeePercent() {
  const raw = process.env.RAZORPAY_FEE_PERCENT;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/**
 * One row per order PLACED in the range (created_at, report-timezone day), with its final economics.
 * Every figure in the P&L is a sum over these rows, so the P&L and orders.csv always tie out.
 *
 *   delivered orders only carry revenue/cost:
 *     fengle_revenue   = commission_amount + delivery_fee            (GST is a pass-through, never revenue)
 *     restaurant_payable (INTERIM) = item_total - commission_amount  (until the settlement model is decided)
 *     rider_payout     = the payout frozen at delivery; orders delivered before that existed use the current formula (source "estimated")
 *     coupon_discount  = coupon_discount_amount                      (platform-funded)
 *     gateway_charge   = RAZORPAY_FEE_PERCENT % of grand_total, only for upi/card/netbanking
 *     net_contribution = fengle_revenue - rider_payout - coupon_discount - gateway_charge
 *   informational (never deducted again): offer_discount = sum((list_price - unit_price) x quantity) over confirmed lines;
 *   refunded = customer wallet credits for the order (delivered totals are already net of dropped items,
 *   and a cancelled order was never counted as a sale).
 */
async function buildOrderEconomics({ from, to }) {
  let q = db("orders as o")
    .leftJoin("restaurants as r", "r.id", "o.restaurant_id")
    .select(
      "o.id", "o.created_at", "o.delivered_at", "o.cancelled_at", "o.status", "o.payment_method", "o.payment_status",
      "o.item_total", "o.delivery_fee", "o.cgst_amount", "o.sgst_amount", "o.coupon_discount_amount", "o.grand_total",
      "o.commission_amount", "o.rider_payout", "o.delivery_lat", "o.delivery_lng", "r.lat as r_lat", "r.lng as r_lng"
    )
    .orderBy("o.created_at", "asc").orderBy("o.id", "asc");
  if (from) q = q.where("o.created_at", ">=", from);
  if (to) q = q.where("o.created_at", "<=", to);
  const orders = await q;

  const ids = orders.map((o) => o.id);
  const refunded = {};
  const offers = {};
  for (const part of chunk(ids, 1000)) {
    const refunds = await db("wallet_ledger").where({ owner_type: "customer", reason: "order_refund" }).whereIn("related_order_id", part)
      .select("related_order_id").sum({ s: "amount" }).groupBy("related_order_id");
    for (const r of refunds) refunded[r.related_order_id] = Number(r.s);
    const lines = await db("order_items").whereIn("order_id", part).andWhere("status", "confirmed").whereNotNull("list_price")
      .select("order_id").select(db.raw("SUM((list_price - unit_price) * quantity) as s")).groupBy("order_id");
    for (const r of lines) offers[r.order_id] = Number(r.s);
  }

  const config = await riderPay.getCurrentConfig();
  const feePct = gatewayFeePercent();

  return orders.map((o) => {
    const delivered = o.status === "delivered";
    const grand = Number(o.grand_total);
    const itemTotal = Number(o.item_total);
    const deliveryFee = Number(o.delivery_fee);
    const commission = Number(o.commission_amount);
    const coupon = Number(o.coupon_discount_amount || 0);
    const gst = money(Number(o.cgst_amount || 0) + Number(o.sgst_amount || 0));

    let riderPayout = 0;
    let riderSource = "";
    if (delivered) {
      if (o.rider_payout != null) { riderPayout = Number(o.rider_payout); riderSource = "stored"; }
      else if (o.r_lat != null) {
        const km = riderPay.orderDistanceKm ? riderPay.orderDistanceKm(o, { lat: o.r_lat, lng: o.r_lng }) : 0;
        riderPayout = riderPay.computePayout({ distanceKm: km, config }).payout;
        riderSource = "estimated";
      }
    }
    const revenue = delivered ? money(commission + deliveryFee) : 0;
    const gateway = delivered && ONLINE_METHODS.includes(o.payment_method) ? money((grand * feePct) / 100) : 0;
    const couponCost = delivered ? coupon : 0;
    return {
      order_id: o.id,
      placed_at: o.created_at, delivered_at: o.delivered_at, cancelled_at: o.cancelled_at,
      status: o.status, payment_method: o.payment_method, payment_status: o.payment_status,
      item_total: itemTotal, delivery_fee: deliveryFee, gst, coupon_discount: coupon, grand_total: grand,
      commission: delivered ? commission : 0,
      fengle_revenue: revenue,
      restaurant_payable: delivered ? money(itemTotal - commission) : 0,
      rider_payout: money(riderPayout), rider_payout_source: riderSource,
      gateway_charge: gateway,
      offer_discount: money(offers[o.id] || 0), refunded: money(refunded[o.id] || 0),
      net_contribution: delivered ? money(revenue - riderPayout - couponCost - gateway) : 0,
    };
  });
}

const sum = (rows, key) => money(rows.reduce((s, r) => s + r[key], 0));

/** Aggregates a set of order-economics rows (and expenses) into the P&L figures. */
function summarize(orderRows, expenseRows) {
  const delivered = orderRows.filter((o) => o.status === "delivered");
  const cancelled = orderRows.filter((o) => o.status === "cancelled");
  const inProgress = orderRows.filter((o) => o.status !== "delivered" && o.status !== "cancelled");
  const expenses = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0]));
  for (const e of expenseRows) expenses[e.category] = money(expenses[e.category] + Number(e.amount));
  const expensesTotal = money(Object.values(expenses).reduce((a, b) => a + b, 0));

  const fengleRevenue = sum(delivered, "fengle_revenue");
  const riderPayouts = sum(delivered, "rider_payout");
  const couponDiscounts = sum(delivered, "coupon_discount");
  const gatewayCharges = sum(delivered, "gateway_charge");
  return {
    orders_placed: orderRows.length,
    gross_order_value: sum(orderRows, "grand_total"),
    delivered_orders: delivered.length,
    delivered_sales: sum(delivered, "grand_total"),
    delivered_item_total: sum(delivered, "item_total"),
    delivered_delivery_fees: sum(delivered, "delivery_fee"),
    gst_collected: sum(delivered, "gst"),
    commission: sum(delivered, "commission"),
    fengle_revenue: fengleRevenue,
    restaurant_payables_interim: sum(delivered, "restaurant_payable"),
    rider_payouts: riderPayouts,
    rider_payouts_stored: money(delivered.filter((o) => o.rider_payout_source === "stored").reduce((s, o) => s + o.rider_payout, 0)),
    rider_payouts_estimated: money(delivered.filter((o) => o.rider_payout_source === "estimated").reduce((s, o) => s + o.rider_payout, 0)),
    rider_payouts_estimated_orders: delivered.filter((o) => o.rider_payout_source === "estimated").length,
    coupon_discounts: couponDiscounts,
    gateway_charges: gatewayCharges,
    offer_discounts_info: sum(delivered, "offer_discount"),
    refunds_info: sum(orderRows, "refunded"),
    cancelled_orders: cancelled.length,
    cancelled_value: sum(cancelled, "grand_total"),
    in_progress_orders: inProgress.length,
    in_progress_value: sum(inProgress, "grand_total"),
    expenses,
    expenses_total: expensesTotal,
    net_profit: money(fengleRevenue - riderPayouts - couponDiscounts - gatewayCharges - expensesTotal),
  };
}

/** Expenses in the range, as { date: 'YYYY-MM-DD', category, amount, ... }. `from`/`to` are instants; expenses are compared by their report-timezone day. */
async function loadExpenses({ from, to }) {
  let q = db("expenses").select("id", "category", "amount", "notes", db.raw("DATE_FORMAT(expense_date, '%Y-%m-%d') as date"));
  if (from) q = q.whereRaw("expense_date >= ?", [dayKey(from)]);
  if (to) q = q.whereRaw("expense_date <= ?", [dayKey(to)]);
  return q.orderBy("expense_date", "asc");
}

/** P&L per period (orders by placement day/month, expenses by their date) plus the grand total. */
async function buildPnl({ from, to, group }) {
  const [orderRows, expenseRows] = await Promise.all([buildOrderEconomics({ from, to }), loadExpenses({ from, to })]);
  const keyOf = group === "month" ? monthKey : dayKey;
  const byPeriod = new Map();
  const bucket = (key) => { if (!byPeriod.has(key)) byPeriod.set(key, { orders: [], expenses: [] }); return byPeriod.get(key); };
  for (const o of orderRows) bucket(keyOf(o.placed_at)).orders.push(o);
  for (const e of expenseRows) bucket(group === "month" ? e.date.slice(0, 7) : e.date).expenses.push(e);
  const periods = [...byPeriod.keys()].sort().map((key) => ({ period: key, ...summarize(byPeriod.get(key).orders, byPeriod.get(key).expenses) }));
  return { periods, totals: summarize(orderRows, expenseRows), orderRows };
}

module.exports = { buildOrderEconomics, buildPnl, summarize, loadExpenses, gatewayFeePercent, EXPENSE_CATEGORIES, ONLINE_METHODS };
