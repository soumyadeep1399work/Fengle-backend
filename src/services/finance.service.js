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
 *     fengle_revenue   = item_total - restaurant_payable + delivery_fee   (GST is a pass-through, never revenue)
 *     restaurant_payable = what Fengle owes the kitchen: sum(vendor_cost x quantity) over confirmed lines, as stored on the order
 *                          (a line with no vendor cost used the old commission formula, and the order is flagged estimated)
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
      "o.commission_amount", "o.restaurant_payable", "o.payable_estimated", "o.rider_payout", "o.delivery_lat", "o.delivery_lng", "r.lat as r_lat", "r.lng as r_lng"
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
    // The stored payable; an order that somehow has none falls back to the old formula and counts as estimated.
    const payableStored = o.restaurant_payable != null ? Number(o.restaurant_payable) : money(itemTotal - commission);
    const payableEstimated = o.restaurant_payable == null || Number(o.payable_estimated) === 1;
    const revenue = delivered ? money(itemTotal - payableStored + deliveryFee) : 0;
    const gateway = delivered && ONLINE_METHODS.includes(o.payment_method) ? money((grand * feePct) / 100) : 0;
    const couponCost = delivered ? coupon : 0;
    return {
      order_id: o.id,
      placed_at: o.created_at, delivered_at: o.delivered_at, cancelled_at: o.cancelled_at,
      status: o.status, payment_method: o.payment_method, payment_status: o.payment_status,
      item_total: itemTotal, delivery_fee: deliveryFee, gst, coupon_discount: coupon, grand_total: grand,
      commission: delivered ? commission : 0, // legacy: no longer drives anything
      fengle_revenue: revenue,
      restaurant_payable: delivered ? payableStored : 0,
      payable_estimated: delivered && payableEstimated,
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
    commission: sum(delivered, "commission"), // legacy / informational
    fengle_revenue: fengleRevenue,
    restaurant_payables: sum(delivered, "restaurant_payable"),
    restaurant_payables_interim: sum(delivered, "restaurant_payable"), // deprecated alias of restaurant_payables, kept so older screens keep working
    payable_estimated_orders: delivered.filter((o) => o.payable_estimated).length,
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

/**
 * Profit per dish for delivered orders PLACED in the range (same basis as the P&L), from the lines' own snapshots:
 *   customer_revenue  = sum(unit_price x quantity)            (what customers paid for the dish, after offers)
 *   vendor_cost_total = sum(vendor_cost x quantity)           (a line placed with no vendor cost uses the old
 *                        commission formula and is counted in estimated_units, flagging the row)
 *   gross_profit      = customer_revenue - vendor_cost_total      margin_percent = gross_profit / customer_revenue
 * Plus the dish's CURRENT price, vendor cost and margin so a mispriced dish stands out.
 */
async function buildProductProfit({ from, to, categoryId }) {
  let q = db("order_items as oi")
    .join("orders as o", "o.id", "oi.order_id")
    .join("items as i", "i.id", "oi.item_id")
    .join("categories as c", "c.id", "i.category_id")
    .leftJoin("restaurants as r", "r.id", "o.restaurant_id")
    .where("o.status", "delivered").andWhere("oi.status", "confirmed")
    .groupBy("i.id", "i.name", "i.category_id", "c.name", "i.price", "i.offer_price", "i.offer_ends_at", "i.vendor_cost", "i.awaiting_price")
    .select("i.id as item_id", "i.name", "i.category_id", "c.name as category_name", "i.price", "i.offer_price", "i.offer_ends_at", "i.vendor_cost", "i.awaiting_price")
    .select(
      db.raw("SUM(oi.quantity) as units"),
      db.raw("SUM(oi.subtotal) as revenue"),
      db.raw("SUM(CASE WHEN oi.vendor_cost IS NOT NULL THEN oi.vendor_cost * oi.quantity ELSE oi.subtotal - oi.subtotal * COALESCE(r.commission_rate_percent, 0) / 100 END) as cost"),
      db.raw("SUM(CASE WHEN oi.vendor_cost IS NULL THEN oi.quantity ELSE 0 END) as estimated_units")
    );
  if (from) q = q.where("o.created_at", ">=", from);
  if (to) q = q.where("o.created_at", "<=", to);
  if (categoryId) q = q.where("i.category_id", categoryId);
  const rows = await q;

  const { presentAdminPricing } = require("../utils/pricing");
  const products = rows.map((r) => {
    const revenue = money(r.revenue);
    const cost = money(r.cost);
    const profit = money(revenue - cost);
    const current = presentAdminPricing({ price: r.price, offer_price: r.offer_price, offer_ends_at: r.offer_ends_at, vendor_cost: r.vendor_cost, awaiting_price: r.awaiting_price });
    return {
      item_id: r.item_id, name: r.name, category_id: r.category_id, category_name: r.category_name,
      units_sold: Number(r.units), customer_revenue: revenue, vendor_cost_total: cost, gross_profit: profit,
      margin_percent: revenue > 0 ? money((profit / revenue) * 100) : null,
      estimated_units: Number(r.estimated_units), has_estimated_cost: Number(r.estimated_units) > 0,
      current_price: current.price, current_effective_price: current.effective_price,
      current_vendor_cost: current.vendor_cost, current_margin: current.margin, current_margin_percent: current.margin_percent,
    };
  }).sort((a, b) => b.gross_profit - a.gross_profit || a.item_id - b.item_id);

  const revenue = money(products.reduce((s, p) => s + p.customer_revenue, 0));
  const cost = money(products.reduce((s, p) => s + p.vendor_cost_total, 0));
  return {
    products,
    totals: {
      products: products.length, units_sold: products.reduce((s, p) => s + p.units_sold, 0), customer_revenue: revenue,
      vendor_cost_total: cost, gross_profit: money(revenue - cost), margin_percent: revenue > 0 ? money(((revenue - cost) / revenue) * 100) : null,
      estimated_units: products.reduce((s, p) => s + p.estimated_units, 0),
    },
  };
}

module.exports = { buildOrderEconomics, buildPnl, buildProductProfit, summarize, loadExpenses, gatewayFeePercent, EXPENSE_CATEGORIES, ONLINE_METHODS };
