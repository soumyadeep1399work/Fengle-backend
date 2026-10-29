const db = require("../config/db");
const settlement = require("../services/restaurantSettlement.service");
const { parseRange } = require("../utils/reportRange");
const { sendCsv } = require("../utils/csv");
const { paginationParams } = require("../utils/pagination");

const money = (n) => Number(Number(n).toFixed(2));
const METHODS = ["bank_transfer", "upi", "cash", "other"];

function rangeOrError(query) {
  const range = parseRange(query);
  return range;
}

// ---------------------------------------------------------------------------
// Overview + statement (reads: super_admin and ops — they expose what each kitchen is paid per dish)
// ---------------------------------------------------------------------------

/** GET /admin/restaurant-settlements?from=&to= → { range, totals, restaurants: [...] } */
async function overview(req, res) {
  const range = rangeOrError(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { rows, totals } = await settlement.settlementOverview(range);
  res.json({ range: { from: range.from, to: range.to }, totals, restaurants: rows });
}

const OVERVIEW_COLUMNS = [
  "restaurant_id", "restaurant_name", "status", "delivered_orders", "payable_earned", "adjustments", "paid",
  "total_payable", "total_adjustments", "total_paid", "outstanding", "estimated_orders_total", "last_payment_at",
];

/** GET /admin/restaurant-settlements.csv?from=&to= — the overview, one row per kitchen. */
async function overviewCsv(req, res) {
  const range = rangeOrError(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { rows } = await settlement.settlementOverview(range);
  sendCsv(res, `restaurant-settlements-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => ({ ...r, last_payment_at: r.last_payment_at ? new Date(r.last_payment_at).toISOString() : "" })), OVERVIEW_COLUMNS);
}

/**
 * GET /admin/restaurants/:id/settlement?from=&to=&page=&limit=
 * → { restaurant, range, opening_balance, payable_earned, adjustments_total, paid_total, closing_balance,
 *     outstanding_now, status, estimated_orders, days, orders (paged), page, limit, total_orders, payments, adjustments }
 */
async function statement(req, res) {
  const range = rangeOrError(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { page, limit, offset } = paginationParams(req, { defaultLimit: 50, maxLimit: 200 });
  const s = await settlement.buildStatement({ restaurantId: Number(req.params.id), from: range.from, to: range.to });
  if (!s) return res.status(404).json({ error: "Restaurant not found" });
  const totalOrders = s.orders.length;
  res.json({ ...s, range: { from: range.from, to: range.to }, orders: s.orders.slice(offset, offset + limit), page, limit, total_orders: totalOrders });
}

/** GET /admin/restaurants/:id/settlement.csv — the statement as one running ledger: orders (+), adjustments (+/-), payments (-), balance after each. */
async function statementCsv(req, res) {
  const range = rangeOrError(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const s = await settlement.buildStatement({ restaurantId: Number(req.params.id), from: range.from, to: range.to });
  if (!s) return res.status(404).json({ error: "Restaurant not found" });

  const events = [
    ...s.orders.map((o) => ({ at: o.delivered_at, type: "order", ref: `#${o.order_id}`, detail: o.items.map((i) => `${i.name} x${i.quantity} @ ${i.vendor_cost ?? "est."}`).join("; "), amount: o.payable, estimated: o.estimated ? "yes" : "" })),
    ...s.adjustments.map((a) => ({ at: a.created_at, type: "adjustment", ref: a.related_order_id ? `#${a.related_order_id}` : "", detail: a.reason, amount: a.amount, estimated: "" })),
    ...s.payments.map((p) => ({ at: p.paid_at, type: "payment", ref: p.reference || "", detail: `${p.method}${p.notes ? ` - ${p.notes}` : ""}`, amount: -p.amount, estimated: "" })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  let balance = s.opening_balance;
  const rows = [{ date: "", type: "opening_balance", reference: "", detail: "", amount: "", estimated: "", balance }];
  for (const e of events) {
    balance = money(balance + e.amount);
    rows.push({ date: new Date(e.at).toISOString(), type: e.type, reference: e.ref, detail: e.detail, amount: e.amount, estimated: e.estimated, balance });
  }
  sendCsv(res, `settlement-${s.restaurant.id}-${new Date().toISOString().slice(0, 10)}.csv`, rows, ["date", "type", "reference", "detail", "amount", "estimated", "balance"]);
}

// ---------------------------------------------------------------------------
// Payments + adjustments (writes: ops + super_admin)
// ---------------------------------------------------------------------------

function parseAmount(raw, { allowNegative = false, max = 10000000 } = {}) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > max) return null;
  const v = money(n);
  if (v === 0 || (!allowNegative && v < 0)) return null;
  return v;
}

function parseWhen(raw, label) {
  if (raw === undefined || raw === null || raw === "") return { value: new Date() };
  const d = new Date(raw);
  if (typeof raw === "boolean" || Number.isNaN(d.getTime())) return { error: `${label} must be a valid date-time` };
  if (d.getTime() > Date.now() + 5 * 60000) return { error: `${label} can't be in the future` };
  return { value: d };
}

/**
 * POST /admin/restaurants/:id/payments { amount, paid_at?, reference, method?, notes?, allow_advance? } (ops + super_admin)
 * Records money Fengle paid the kitchen (whenever an admin pays: there is no fixed cycle). `reference` (UTR / transaction
 * id, ≤100 chars) is required except for method "cash" and is unique per kitchen, so double-submitting is a 409.
 * A payment above what is outstanding is refused (409 with the outstanding) unless `allow_advance: true`.
 */
async function createPayment(req, res) {
  const restaurantId = Number(req.params.id);
  const { amount, paid_at, reference, method = "bank_transfer", notes, allow_advance } = req.body || {};
  const value = parseAmount(amount);
  if (value === null) return res.status(400).json({ error: "amount must be a positive number" });
  if (!METHODS.includes(method)) return res.status(400).json({ error: `method must be one of: ${METHODS.join(", ")}` });
  const when = parseWhen(paid_at, "paid_at");
  if (when.error) return res.status(400).json({ error: when.error });
  const ref = typeof reference === "string" && reference.trim() ? reference.trim() : null;
  if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.trim().length > 100)) return res.status(400).json({ error: "reference must be a string of at most 100 characters" });
  if (!ref && method !== "cash") return res.status(400).json({ error: "reference (the UTR / transaction id) is required unless the method is cash" });
  if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > 500)) return res.status(400).json({ error: "notes must be a string of at most 500 characters" });

  try {
    const result = await db.transaction(async (trx) => {
      const kitchen = await trx("restaurants").where({ id: restaurantId }).forUpdate().first();
      if (!kitchen) return { status: 404, body: { error: "Restaurant not found" } };
      if (ref && (await trx("restaurant_payments").where({ restaurant_id: restaurantId, reference: ref }).first())) {
        return { status: 409, body: { error: `A payment with reference "${ref}" is already recorded for this kitchen` } };
      }
      const outstanding = await settlement.outstandingFor(trx, restaurantId);
      if (value > outstanding + settlement.EPS && allow_advance !== true) {
        return { status: 409, body: { error: `This kitchen is only owed ₹${Math.max(0, outstanding)} — ₹${value} is more than is outstanding. Send allow_advance: true to record it as an advance.`, outstanding: Math.max(0, outstanding) } };
      }
      const [id] = await trx("restaurant_payments").insert({
        restaurant_id: restaurantId, amount: value, paid_at: when.value, reference: ref, method, notes: notes || null, recorded_by_admin_id: req.auth.id,
      });
      const row = await trx("restaurant_payments").where({ id }).first();
      return { status: 201, body: { payment: settlement.presentPayment(row), outstanding_after: money(outstanding - value) } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "That payment reference is already recorded for this kitchen" });
    throw err;
  }
}

/** GET /admin/restaurant-payments?restaurant_id=&from=&to=&page=&limit= → { payments, page, limit, total, total_amount } newest first (super_admin + ops) */
async function listPayments(req, res) {
  const range = rangeOrError(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { page, limit, offset } = paginationParams(req);
  let base = db("restaurant_payments as p");
  if (req.query.restaurant_id) base = base.where("p.restaurant_id", Number(req.query.restaurant_id));
  if (range.from) base = base.where("p.paid_at", ">=", range.from);
  if (range.to) base = base.where("p.paid_at", "<=", range.to);
  const [{ n, total }] = await base.clone().select(db.raw("COUNT(*) as n"), db.raw("COALESCE(SUM(p.amount), 0) as total"));
  const rows = await base.clone().join("restaurants as r", "r.id", "p.restaurant_id").leftJoin("admins as a", "a.id", "p.recorded_by_admin_id")
    .orderBy("p.paid_at", "desc").orderBy("p.id", "desc").limit(limit).offset(offset)
    .select("p.*", "r.name as restaurant_name", "a.name as recorded_by_admin_name");
  res.json({ payments: rows.map((r) => ({ ...settlement.presentPayment(r), restaurant_name: r.restaurant_name })), page, limit, total: Number(n), total_amount: money(total) });
}

/**
 * POST /admin/restaurants/:id/adjustments { amount (+ owed to the kitchen, - deduction), reason, related_order_id? } (ops + super_admin)
 * For anything agreed off-system (e.g. a penalty for a kitchen-caused cancellation). Counts in the outstanding immediately.
 */
async function createAdjustment(req, res) {
  const restaurantId = Number(req.params.id);
  const { amount, reason, related_order_id } = req.body || {};
  const value = parseAmount(amount, { allowNegative: true });
  if (value === null) return res.status(400).json({ error: "amount must be a non-zero number (positive = owed to the kitchen, negative = a deduction)" });
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 255) return res.status(400).json({ error: "reason is required (up to 255 characters)" });
  const kitchen = await db("restaurants").where({ id: restaurantId }).first("id");
  if (!kitchen) return res.status(404).json({ error: "Restaurant not found" });
  let relatedId = null;
  if (related_order_id !== undefined && related_order_id !== null && related_order_id !== "") {
    relatedId = Number(related_order_id);
    const order = Number.isInteger(relatedId) ? await db("orders").where({ id: relatedId }).first("id", "restaurant_id") : null;
    if (!order || Number(order.restaurant_id) !== restaurantId) return res.status(400).json({ error: "related_order_id must be an order of this kitchen" });
  }
  const [id] = await db("restaurant_adjustments").insert({ restaurant_id: restaurantId, amount: value, reason: reason.trim(), related_order_id: relatedId, created_by_admin_id: req.auth.id });
  const row = await db("restaurant_adjustments").where({ id }).first();
  res.status(201).json({ adjustment: settlement.presentAdjustment(row), outstanding_after: await settlement.outstandingFor(db, restaurantId) });
}

/** GET /admin/restaurant-adjustments?restaurant_id=&from=&to=&page=&limit= → { adjustments, page, limit, total, total_amount } (super_admin + ops) */
async function listAdjustments(req, res) {
  const range = rangeOrError(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { page, limit, offset } = paginationParams(req);
  let base = db("restaurant_adjustments as a");
  if (req.query.restaurant_id) base = base.where("a.restaurant_id", Number(req.query.restaurant_id));
  if (range.from) base = base.where("a.created_at", ">=", range.from);
  if (range.to) base = base.where("a.created_at", "<=", range.to);
  const [{ n, total }] = await base.clone().select(db.raw("COUNT(*) as n"), db.raw("COALESCE(SUM(a.amount), 0) as total"));
  const rows = await base.clone().join("restaurants as r", "r.id", "a.restaurant_id").leftJoin("admins as ad", "ad.id", "a.created_by_admin_id")
    .orderBy("a.created_at", "desc").orderBy("a.id", "desc").limit(limit).offset(offset)
    .select("a.*", "r.name as restaurant_name", "ad.name as created_by_admin_name");
  res.json({ adjustments: rows.map((r) => ({ ...settlement.presentAdjustment(r), restaurant_name: r.restaurant_name })), page, limit, total: Number(n), total_amount: money(total) });
}

module.exports = { overview, overviewCsv, statement, statementCsv, createPayment, listPayments, createAdjustment, listAdjustments };
