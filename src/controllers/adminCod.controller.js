const db = require("../config/db");
const wallet = require("../services/wallet.service");
const { parseRange } = require("../utils/reportRange");
const { sendCsv } = require("../utils/csv");
const { paginationParams } = require("../utils/pagination");

const EPS = 0.005;
const money = (n) => Number(Number(n).toFixed(2));
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

// ---------------------------------------------------------------------------
// Cash handovers: a rider hands COD cash to Fengle and an admin records it.
// ---------------------------------------------------------------------------

const present = (r) => ({
  id: r.id, rider_id: r.rider_id, rider_name: r.rider_name ?? undefined, amount: Number(r.amount),
  received_at: r.received_at, reference: r.reference, notes: r.notes,
  received_by_admin_id: r.received_by_admin_id, received_by_admin_name: r.received_by_admin_name ?? undefined,
  balance_after: r.balance_after == null ? undefined : Number(r.balance_after), created_at: r.created_at,
});

/**
 * POST /admin/riders/:id/cash-handovers { amount, received_at?, reference?, notes? } (ops + super_admin)
 * Writes a wallet_ledger CREDIT (reason `cash_handover`) that reduces the rider's outstanding COD
 * (their negative wallet balance). The amount can't exceed what the rider currently owes (a typo
 * guard — 409 says how much is outstanding). `reference` is unique per rider, so double-submitting
 * the same receipt is a 409, not a second credit. received_at defaults to now and can't be in the future.
 */
async function createCashHandover(req, res) {
  const riderId = Number(req.params.id);
  const { amount, received_at, reference, notes } = req.body || {};

  const value = typeof amount === "string" && amount.trim() !== "" ? Number(amount) : amount;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000000) {
    return res.status(400).json({ error: "amount must be a positive number (up to 1000000)" });
  }
  const cash = money(value);
  if (cash <= 0) return res.status(400).json({ error: "amount must be a positive number" });

  let receivedAt = new Date();
  if (received_at !== undefined && received_at !== null && received_at !== "") {
    receivedAt = new Date(received_at);
    if (typeof received_at === "boolean" || Number.isNaN(receivedAt.getTime())) return res.status(400).json({ error: "received_at must be a valid date-time" });
    if (receivedAt.getTime() > Date.now() + 5 * 60000) return res.status(400).json({ error: "received_at can't be in the future" });
  }
  if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.trim().length > 100)) {
    return res.status(400).json({ error: "reference must be a string of at most 100 characters" });
  }
  if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > 500)) {
    return res.status(400).json({ error: "notes must be a string of at most 500 characters" });
  }
  const cleanReference = typeof reference === "string" && reference.trim() ? reference.trim() : null;

  try {
    const result = await db.transaction(async (trx) => {
      const rider = await trx("riders").where({ id: riderId }).forUpdate().first();
      if (!rider) return { status: 404, body: { error: "Rider not found" } };

      if (cleanReference) {
        const dup = await trx("cash_handovers").where({ rider_id: riderId, reference: cleanReference }).first();
        if (dup) return { status: 409, body: { error: `A handover with reference "${cleanReference}" is already recorded for this rider` } };
      }

      const outstanding = Math.max(0, money(-Number(rider.wallet_balance)));
      if (cash > outstanding + EPS) {
        return { status: 409, body: { error: `This rider only owes ₹${outstanding} in COD cash — ₹${cash} is more than is outstanding`, outstanding } };
      }

      const balanceAfter = await wallet.recordEntry(
        { ownerType: "rider", ownerId: riderId, entryType: "credit", amount: cash, reason: "cash_handover", notes: `Cash handover received${cleanReference ? ` (ref ${cleanReference})` : ""}` },
        trx
      );
      const ledger = await trx("wallet_ledger").where({ owner_type: "rider", owner_id: riderId, reason: "cash_handover" }).orderBy("id", "desc").first();
      const [id] = await trx("cash_handovers").insert({
        rider_id: riderId, amount: cash, received_at: receivedAt, reference: cleanReference,
        notes: notes || null, received_by_admin_id: req.auth.id, ledger_entry_id: ledger ? ledger.id : null,
      });
      const row = await trx("cash_handovers").where({ id }).first();
      return { status: 201, body: { handover: { ...present({ ...row, balance_after: balanceAfter }), outstanding_after: Math.max(0, money(-balanceAfter)) } } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "That handover reference is already recorded for this rider" });
    throw err;
  }
}

/** GET /admin/cash-handovers?rider_id=&from=&to=&page=&limit= — history, newest first, with the total handed over. */
async function listCashHandovers(req, res) {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { page, limit, offset } = paginationParams(req);

  let base = db("cash_handovers as h");
  if (req.query.rider_id) base = base.where("h.rider_id", Number(req.query.rider_id));
  if (range.from) base = base.where("h.received_at", ">=", range.from);
  if (range.to) base = base.where("h.received_at", "<=", range.to);

  const [{ n, total }] = await base.clone().select(db.raw("COUNT(*) as n"), db.raw("COALESCE(SUM(h.amount), 0) as total"));
  const rows = await base
    .clone()
    .join("riders as r", "r.id", "h.rider_id")
    .leftJoin("admins as a", "a.id", "h.received_by_admin_id")
    .leftJoin("wallet_ledger as l", "l.id", "h.ledger_entry_id")
    .orderBy("h.received_at", "desc").orderBy("h.id", "desc")
    .limit(limit).offset(offset)
    .select("h.*", "r.name as rider_name", "a.name as received_by_admin_name", "l.balance_after");

  res.json({ handovers: rows.map(present), page, limit, total: Number(n), total_amount: money(total) });
}

// ---------------------------------------------------------------------------
// Reconciliation: expected vs collected vs handed over
// ---------------------------------------------------------------------------

/**
 * Builds the reconciliation: one row per closed (delivered or cancelled) COD order whose closing date
 * falls in the range, plus one row per rider. Pure read; used by the JSON and CSV endpoints.
 *
 *   closing date  = COALESCE(delivered_at, cancelled_at, created_at)
 *   expected      = grand_total for a delivered order; 0 for a cancelled one (no cash should change hands)
 *   collected     = sum of the rider's `cod_collected` ledger debits for that order (what the rider confirmed)
 *   difference    = collected - expected
 *   flag          = "short" / "excess" (delivered, difference != 0) or "unexpected_collection" (cancelled but cash was collected)
 *   refunded      = what was credited back to the customer's wallet for the order
 */
async function buildReconciliation({ from, to, riderId }) {
  let orderQuery = db("orders as o")
    .leftJoin("riders as r", "r.id", "o.rider_id")
    .where("o.payment_method", "cod")
    .whereIn("o.status", ["delivered", "cancelled"])
    .select(
      "o.id", "o.status", "o.payment_status", "o.grand_total", "o.rider_id", "r.name as rider_name",
      db.raw("COALESCE(o.delivered_at, o.cancelled_at, o.created_at) as closed_at")
    );
  if (from) orderQuery = orderQuery.whereRaw("COALESCE(o.delivered_at, o.cancelled_at, o.created_at) >= ?", [from]);
  if (to) orderQuery = orderQuery.whereRaw("COALESCE(o.delivered_at, o.cancelled_at, o.created_at) <= ?", [to]);
  if (riderId) orderQuery = orderQuery.where("o.rider_id", riderId);
  const orders = await orderQuery.orderBy("closed_at", "desc").orderBy("o.id", "desc");

  const orderIds = orders.map((o) => o.id);
  const collectedByOrder = {};
  const refundedByOrder = {};
  for (const ids of chunk(orderIds, 1000)) {
    const collected = await db("wallet_ledger").where({ owner_type: "rider", reason: "cod_collected" }).whereIn("related_order_id", ids)
      .select("related_order_id").sum({ s: "amount" }).groupBy("related_order_id");
    for (const r of collected) collectedByOrder[r.related_order_id] = Number(r.s);
    const refunded = await db("wallet_ledger").where({ owner_type: "customer", reason: "order_refund" }).whereIn("related_order_id", ids)
      .select("related_order_id").sum({ s: "amount" }).groupBy("related_order_id");
    for (const r of refunded) refundedByOrder[r.related_order_id] = Number(r.s);
  }

  const orderRows = orders.map((o) => {
    const grandTotal = Number(o.grand_total);
    const expected = o.status === "delivered" ? grandTotal : 0;
    const collected = money(collectedByOrder[o.id] || 0);
    const difference = money(collected - expected);
    let flag = null;
    if (o.status === "delivered") flag = difference < -EPS ? "short" : difference > EPS ? "excess" : null;
    else if (collected > EPS) flag = "unexpected_collection";
    return {
      order_id: o.id, status: o.status, payment_status: o.payment_status, rider_id: o.rider_id, rider_name: o.rider_name || null,
      closed_at: o.closed_at, grand_total: grandTotal, expected, collected, difference,
      refunded: money(refundedByOrder[o.id] || 0), flag,
    };
  });

  // Handovers in the same window (by the time the cash was received).
  let handoverQuery = db("cash_handovers as h").select("h.rider_id").sum({ s: "h.amount" }).groupBy("h.rider_id");
  if (from) handoverQuery = handoverQuery.where("h.received_at", ">=", from);
  if (to) handoverQuery = handoverQuery.where("h.received_at", "<=", to);
  if (riderId) handoverQuery = handoverQuery.where("h.rider_id", riderId);
  const handedByRider = Object.fromEntries((await handoverQuery).map((r) => [r.rider_id, Number(r.s)]));

  // Who appears: anyone with COD activity or a handover in the window, plus anyone who currently owes cash.
  const activeIds = new Set([...orders.map((o) => o.rider_id).filter(Boolean), ...Object.keys(handedByRider).map(Number)]);
  let riderQuery = db("riders").select("id", "name", "phone", "wallet_balance");
  if (riderId) riderQuery = riderQuery.where({ id: riderId });
  const riders = (await riderQuery).filter((r) => activeIds.has(r.id) || (!riderId && Number(r.wallet_balance) < -EPS) || riderId);

  const riderRows = riders.map((r) => {
    const mine = orderRows.filter((o) => o.rider_id === r.id);
    const delivered = mine.filter((o) => o.status === "delivered");
    const expected = money(delivered.reduce((s, o) => s + o.expected, 0));
    const collected = money(mine.reduce((s, o) => s + o.collected, 0));
    const handedOver = money(handedByRider[r.id] || 0);
    return {
      rider_id: r.id, rider_name: r.name, rider_phone: r.phone,
      delivered_cod_orders: delivered.length, expected, collected, difference: money(collected - expected),
      flagged_orders: mine.filter((o) => o.flag).length,
      handed_over: handedOver,
      net_cash_in_period: money(collected - handedOver),
      outstanding: Math.max(0, money(-Number(r.wallet_balance))), // as of now, not scoped to the dates
    };
  }).sort((a, b) => b.outstanding - a.outstanding || a.rider_id - b.rider_id);

  const sum = (rows, key) => money(rows.reduce((s, r) => s + r[key], 0));
  const totals = {
    delivered_cod_orders: riderRows.reduce((s, r) => s + r.delivered_cod_orders, 0),
    expected: sum(riderRows, "expected"), collected: sum(riderRows, "collected"), difference: sum(riderRows, "difference"),
    flagged_orders: orderRows.filter((o) => o.flag).length, handed_over: sum(riderRows, "handed_over"),
    net_cash_in_period: sum(riderRows, "net_cash_in_period"), outstanding: sum(riderRows, "outstanding"),
    cod_orders: orderRows.length,
  };
  return { orderRows, riderRows, totals };
}

/**
 * GET /admin/cod/reconciliation?from=&to=&rider_id=&flagged=1&page=&limit=
 * → { range, totals, riders: [...], orders: [...] (paged), page, limit, total_orders }
 * `flagged=1` limits `orders` to rows where collected != expected. All admin roles. See buildReconciliation for definitions.
 */
async function codReconciliation(req, res) {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { page, limit, offset } = paginationParams(req, { defaultLimit: 100, maxLimit: 500 });
  const { orderRows, riderRows, totals } = await buildReconciliation({ from: range.from, to: range.to, riderId: req.query.rider_id ? Number(req.query.rider_id) : null });
  const filtered = req.query.flagged === "1" || req.query.flagged === "true" ? orderRows.filter((o) => o.flag) : orderRows;
  res.json({
    range: { from: range.from, to: range.to }, totals, riders: riderRows,
    orders: filtered.slice(offset, offset + limit), page, limit, total_orders: filtered.length,
  });
}

/** GET /admin/cod/reconciliation.csv?view=orders|riders (default orders) — same filters, every row, no paging. */
async function codReconciliationCsv(req, res) {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const { orderRows, riderRows } = await buildReconciliation({ from: range.from, to: range.to, riderId: req.query.rider_id ? Number(req.query.rider_id) : null });
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.view === "riders") {
    return sendCsv(res, `cod-riders-${stamp}.csv`, riderRows, [
      "rider_id", "rider_name", "rider_phone", "delivered_cod_orders", "expected", "collected", "difference", "flagged_orders", "handed_over", "net_cash_in_period", "outstanding",
    ]);
  }
  const rows = (req.query.flagged === "1" || req.query.flagged === "true" ? orderRows.filter((o) => o.flag) : orderRows).map((o) => ({ ...o, closed_at: new Date(o.closed_at).toISOString() }));
  sendCsv(res, `cod-orders-${stamp}.csv`, rows, [
    "order_id", "closed_at", "status", "payment_status", "rider_id", "rider_name", "grand_total", "expected", "collected", "difference", "refunded", "flag",
  ]);
}

module.exports = { createCashHandover, listCashHandovers, codReconciliation, codReconciliationCsv, buildReconciliation };
