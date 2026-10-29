const db = require("../config/db");
const finance = require("../services/finance.service");
const { parseRange, dayKey } = require("../utils/reportRange");
const { sendCsv } = require("../utils/csv");
const { paginationParams } = require("../utils/pagination");

const money = (n) => Number(Number(n).toFixed(2));
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Expenses (super_admin)
// ---------------------------------------------------------------------------

function isRealDate(s) {
  const m = DATE_ONLY.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Validates expense input. `partial` = PATCH (only the keys present are checked). Returns { error } or { fields }. */
function parseExpense(body, { partial }) {
  const fields = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has("date")) {
    if (!isRealDate(body.date)) return { error: "date must be a real date as YYYY-MM-DD" };
    fields.expense_date = body.date;
  }
  if (!partial || has("category")) {
    if (!finance.EXPENSE_CATEGORIES.includes(body.category)) return { error: `category must be one of: ${finance.EXPENSE_CATEGORIES.join(", ")}` };
    fields.category = body.category;
  }
  if (!partial || has("amount")) {
    const raw = body.amount;
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 100000000) return { error: "amount must be a positive number" };
    fields.amount = money(n);
    if (fields.amount <= 0) return { error: "amount must be a positive number" };
  }
  if (has("notes")) {
    if (body.notes !== null && (typeof body.notes !== "string" || body.notes.length > 500)) return { error: "notes must be a string of at most 500 characters" };
    fields.notes = body.notes || null;
  }
  return { fields };
}

const presentExpense = (r) => ({
  id: r.id, date: r.date, category: r.category, amount: Number(r.amount), notes: r.notes,
  created_by_admin_id: r.created_by_admin_id, created_at: r.created_at, updated_at: r.updated_at,
});
const EXPENSE_SELECT = ["id", "category", "amount", "notes", "created_by_admin_id", "created_at", "updated_at", db.raw("DATE_FORMAT(expense_date, '%Y-%m-%d') as date")];

/** POST /admin/expenses { date, category: marketing|operating|salaries|other, amount, notes? } → 201 { expense } */
async function createExpense(req, res) {
  const parsed = parseExpense(req.body || {}, { partial: false });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const [id] = await db("expenses").insert({ ...parsed.fields, created_by_admin_id: req.auth.id });
  res.status(201).json({ expense: presentExpense(await db("expenses").where({ id }).first(...EXPENSE_SELECT)) });
}

/** GET /admin/expenses?from=&to=&category=&page=&limit= → { expenses, page, limit, total, total_amount, by_category } (newest first) */
async function listExpenses(req, res) {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  if (req.query.category && !finance.EXPENSE_CATEGORIES.includes(req.query.category)) {
    return res.status(400).json({ error: `category must be one of: ${finance.EXPENSE_CATEGORIES.join(", ")}` });
  }
  const { page, limit, offset } = paginationParams(req);
  let base = db("expenses");
  if (range.from) base = base.whereRaw("expense_date >= ?", [dayKey(range.from)]);
  if (range.to) base = base.whereRaw("expense_date <= ?", [dayKey(range.to)]);
  if (req.query.category) base = base.where({ category: req.query.category });

  const [{ n, total }] = await base.clone().select(db.raw("COUNT(*) as n"), db.raw("COALESCE(SUM(amount), 0) as total"));
  const cats = await base.clone().select("category").sum({ s: "amount" }).groupBy("category");
  const byCategory = Object.fromEntries(finance.EXPENSE_CATEGORIES.map((c) => [c, 0]));
  for (const c of cats) byCategory[c.category] = money(c.s);
  const rows = await base.clone().orderBy("expense_date", "desc").orderBy("id", "desc").limit(limit).offset(offset).select(...EXPENSE_SELECT);
  res.json({ expenses: rows.map(presentExpense), page, limit, total: Number(n), total_amount: money(total), by_category: byCategory });
}

/** PATCH /admin/expenses/:id — any of { date, category, amount, notes } → { expense } */
async function updateExpense(req, res) {
  const id = Number(req.params.id);
  const existing = await db("expenses").where({ id }).first();
  if (!existing) return res.status(404).json({ error: "Expense not found" });
  const parsed = parseExpense(req.body || {}, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (Object.keys(parsed.fields).length === 0) return res.status(400).json({ error: "Send at least one of: date, category, amount, notes" });
  await db("expenses").where({ id }).update({ ...parsed.fields, updated_at: db.fn.now() });
  res.json({ expense: presentExpense(await db("expenses").where({ id }).first(...EXPENSE_SELECT)) });
}

/** DELETE /admin/expenses/:id → { message } */
async function deleteExpense(req, res) {
  const deleted = await db("expenses").where({ id: Number(req.params.id) }).delete();
  if (!deleted) return res.status(404).json({ error: "Expense not found" });
  res.json({ message: "Expense deleted" });
}

// ---------------------------------------------------------------------------
// Profit & loss (super_admin)
// ---------------------------------------------------------------------------

/** Range for finance reports: explicit from/to, or (when neither is given) the current report-timezone month so far. */
function financeRange(query) {
  const range = parseRange(query);
  if (range.error) return range;
  if (!range.from && !range.to) {
    const today = dayKey(new Date());
    return parseRange({ from: `${today.slice(0, 7)}-01`, to: today });
  }
  return range;
}

const FORMULAS = {
  basis: "Every order figure is for orders PLACED in the period (report-timezone day/month); expenses use their own date. Dates are IST days (REPORT_TZ_OFFSET_MINUTES).",
  gross_order_value: "sum of grand_total over all orders placed (any status)",
  delivered_sales: "sum of grand_total over delivered orders (includes GST and delivery fee, after coupons)",
  fengle_revenue: "sum over delivered orders of (item_total - restaurant_payable + delivery_fee); item_total is what customers paid for the food after dish offers; GST is a pass-through and is never revenue",
  restaurant_payables: "sum of orders.restaurant_payable over delivered orders = what Fengle owes kitchens: vendor cost x quantity per confirmed line, never reduced by coupons or offers (Fengle bears all discounts). A line whose dish had no vendor cost uses the old estimate (line subtotal minus the kitchen's commission %) and its order counts in payable_estimated_orders",
  payable_estimated_orders: "delivered orders whose payable includes at least one estimated line (a dish still missing its vendor cost) — set the dish costs to make the payables exact",
  commission: "legacy/informational only: the old commission_amount; it no longer drives revenue or payables",
  rider_payouts: "sum of the rider payout frozen at delivery; delivered orders without one use the current rider-pay formula (rider_payouts_estimated)",
  coupon_discounts: "sum of coupon_discount_amount over delivered orders (platform-funded)",
  gateway_charges: "RAZORPAY_FEE_PERCENT % of grand_total over delivered orders paid by upi/card/netbanking (COD and wallet carry no fee)",
  expenses: "sum of expenses by category, by expense date",
  net_profit: "fengle_revenue - rider_payouts - coupon_discounts - gateway_charges - expenses_total",
  offer_discounts_info: "informational: sum of (list_price - unit_price) x quantity over delivered orders' lines; already inside the lower item_total, so not deducted again",
  refunds_info: "informational: customer wallet refunds for those orders; delivered totals are already net of dropped items and cancelled orders are never counted as sales, so not deducted again",
  cancelled: "orders with status cancelled: count and grand_total",
};

/** GET /admin/finance/pnl?from=&to=&group=day|month → { range, group, gateway_fee_percent, formulas, periods, totals } */
async function pnl(req, res) {
  const range = financeRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const group = req.query.group === "month" ? "month" : "day";
  if (req.query.group && !["day", "month"].includes(req.query.group)) return res.status(400).json({ error: "group must be 'day' or 'month'" });
  const { periods, totals } = await finance.buildPnl({ from: range.from, to: range.to, group });
  res.json({ range: { from: range.from, to: range.to }, group, gateway_fee_percent: finance.gatewayFeePercent(), formulas: FORMULAS, periods, totals });
}

const PNL_COLUMNS = [
  "period", "orders_placed", "gross_order_value", "delivered_orders", "delivered_sales", "delivered_item_total", "delivered_delivery_fees",
  "gst_collected", "fengle_revenue", "restaurant_payables", "payable_estimated_orders", "rider_payouts", "rider_payouts_estimated",
  "coupon_discounts", "gateway_charges", "expenses_marketing", "expenses_operating", "expenses_salaries", "expenses_other", "expenses_total",
  "net_profit", "offer_discounts_info", "refunds_info", "cancelled_orders", "cancelled_value", "in_progress_orders", "in_progress_value",
];

/** GET /admin/finance/pnl.csv?from=&to=&group= — one row per period plus a TOTAL row. */
async function pnlCsv(req, res) {
  const range = financeRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const group = req.query.group === "month" ? "month" : "day";
  const { periods, totals } = await finance.buildPnl({ from: range.from, to: range.to, group });
  const flat = (p) => ({ ...p, expenses_marketing: p.expenses.marketing, expenses_operating: p.expenses.operating, expenses_salaries: p.expenses.salaries, expenses_other: p.expenses.other });
  const rows = [...periods.map(flat), flat({ period: "TOTAL", ...totals })];
  sendCsv(res, `pnl-${group}-${dayKey(new Date())}.csv`, rows, PNL_COLUMNS);
}

const ORDER_COLUMNS = [
  "order_id", "placed_at", "delivered_at", "cancelled_at", "status", "payment_method", "payment_status",
  "item_total", "delivery_fee", "gst", "coupon_discount", "grand_total", "fengle_revenue", "restaurant_payable", "payable_estimated",
  "rider_payout", "rider_payout_source", "gateway_charge", "offer_discount", "refunded", "net_contribution",
];

/** GET /admin/finance/orders.csv?from=&to= — order-wise transactions (orders placed in the range), the same rows the P&L sums. */
async function ordersCsv(req, res) {
  const range = financeRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const rows = (await finance.buildOrderEconomics({ from: range.from, to: range.to })).map((o) => ({
    ...o,
    payable_estimated: o.payable_estimated ? "yes" : "",
    placed_at: o.placed_at ? new Date(o.placed_at).toISOString() : "",
    delivered_at: o.delivered_at ? new Date(o.delivered_at).toISOString() : "",
    cancelled_at: o.cancelled_at ? new Date(o.cancelled_at).toISOString() : "",
  }));
  sendCsv(res, `finance-orders-${dayKey(new Date())}.csv`, rows, ORDER_COLUMNS);
}

/**
 * GET /admin/finance/products?from=&to=&category_id= → { range, products: [...], totals } (super_admin) — profit per dish for delivered
 * orders placed in the range. See finance.service.buildProductProfit for the definitions.
 */
async function products(req, res) {
  const range = financeRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const result = await finance.buildProductProfit({ from: range.from, to: range.to, categoryId: req.query.category_id ? Number(req.query.category_id) : null });
  res.json({ range: { from: range.from, to: range.to }, ...result });
}

const PRODUCT_COLUMNS = [
  "item_id", "name", "category_name", "units_sold", "customer_revenue", "vendor_cost_total", "gross_profit", "margin_percent", "estimated_units",
  "current_price", "current_effective_price", "current_vendor_cost", "current_margin", "current_margin_percent",
];

/** GET /admin/finance/products.csv — the same rows as /admin/finance/products. */
async function productsCsv(req, res) {
  const range = financeRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { products: rows } = await finance.buildProductProfit({ from: range.from, to: range.to, categoryId: req.query.category_id ? Number(req.query.category_id) : null });
  sendCsv(res, `product-profit-${dayKey(new Date())}.csv`, rows, PRODUCT_COLUMNS);
}

module.exports = { createExpense, listExpenses, updateExpense, deleteExpense, pnl, pnlCsv, ordersCsv, products, productsCsv };
