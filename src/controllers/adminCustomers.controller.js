const db = require("../config/db");
const wallet = require("../services/wallet.service");
const { paginationParams } = require("../utils/pagination");
const { listOrdersForOwner } = require("./adminOrders.controller");
const { promoOptIn } = require("../services/push.service");

function customersWithOrderStats() {
  return db("users as u")
    .leftJoin("orders as o", "o.customer_id", "u.id")
    .groupBy("u.id")
    .select(
      "u.id", "u.name", "u.phone", "u.email", "u.status", "u.wallet_balance", "u.notification_prefs", "u.created_at",
      db.raw("COUNT(o.id) as order_count"),
      db.raw("COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.grand_total ELSE 0 END), 0) as total_spent"),
      db.raw("MAX(o.created_at) as last_order_at")
    );
}

function serializeCustomerRow(r) {
  return {
    id: r.id, name: r.name, phone: r.phone, email: r.email, status: r.status,
    wallet_balance: Number(r.wallet_balance),
    order_count: Number(r.order_count),
    total_spent: Number(r.total_spent),
    last_order_at: r.last_order_at,
    created_at: r.created_at,
    promo_opt_in: promoOptIn(r.notification_prefs),
  };
}

/**
 * Shared by GET /admin/customers and GET /admin/customers/export.csv so the
 * list preview count always matches what the CSV would actually contain —
 * q/status (basic search) plus the campaign-targeting filters: promo_opt_in
 * (default "1" — opted-in only, this exists for promo campaigns),
 * min_orders/max_orders (max_orders=0 means "never ordered"), inactive_days
 * (no order in N days, or never ordered), ordered_category_id.
 * `forceActiveOnly` hard-excludes blocked customers regardless of `status`
 * — used by the CSV export so a blocked customer can never end up in a
 * campaign list, even if someone explicitly asks for status=blocked there.
 */
function applyCampaignFilters(query, params, { forceActiveOnly = false } = {}) {
  const { q, status, promo_opt_in, min_orders, max_orders, inactive_days, ordered_category_id } = params;

  if (forceActiveOnly) {
    query = query.where("u.status", "active");
  } else if (status) {
    query = query.where("u.status", status);
  }
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query = query.andWhere((qb) => qb.where("u.name", "like", term).orWhere("u.phone", "like", term).orWhere("u.email", "like", term));
  }
  if (ordered_category_id) {
    const sub = db("order_items").join("orders", "orders.id", "order_items.order_id").where("order_items.category_id", ordered_category_id).select("orders.customer_id").distinct();
    query = query.whereIn("u.id", sub);
  }
  if (min_orders !== undefined) query = query.havingRaw("COUNT(o.id) >= ?", [Number(min_orders)]);
  if (max_orders !== undefined) query = query.havingRaw("COUNT(o.id) <= ?", [Number(max_orders)]);
  if (inactive_days !== undefined) {
    query = query.havingRaw("MAX(o.created_at) IS NULL OR MAX(o.created_at) <= DATE_SUB(NOW(), INTERVAL ? DAY)", [Number(inactive_days)]);
  }

  // promo_opt_in=1 (or anything but "0") filters to opted-in only; "0" or
  // absent means no filter. Applied in JS (not SQL) since promoOptIn() reads
  // a JSON column that varies in shape (string vs. parsed object vs. null).
  const wantOptInOnly = promo_opt_in !== undefined && promo_opt_in !== "0";
  return { query, filterInJs: (row) => (wantOptInOnly ? promoOptIn(row.notification_prefs) : true) };
}

/**
 * GET /admin/customers?page=&limit=&q=&status=&promo_opt_in=&min_orders=&max_orders=&inactive_days=&ordered_category_id=
 * Accepts the exact same campaign filters as export.csv (minus the forced
 * active-only rule) so a preview count matches what exporting would give.
 */
async function listCustomers(req, res) {
  if (req.query.status && !["active", "blocked"].includes(req.query.status)) {
    return res.status(400).json({ error: "status must be 'active' or 'blocked'" });
  }
  const { page, limit, offset } = paginationParams(req);

  const { query, filterInJs } = applyCampaignFilters(customersWithOrderStats(), req.query);
  const all = await query;
  const filtered = all.filter(filterInJs);
  const total = filtered.length;
  const pageRows = filtered.slice(offset, offset + limit);

  res.json({ customers: pageRows.map(serializeCustomerRow), page, limit, total });
}

/**
 * GET /admin/customers/:id — profile + stats, all orders, and the wallet
 * ledger. Orders come from the shared listOrdersForOwner helper (same shape
 * as GET /admin/orders rows) rather than a raw select on orders, which would
 * leak delivery_otp.
 */
async function getCustomer(req, res) {
  const { id } = req.params;
  const row = await customersWithOrderStats().where("u.id", id).first();
  if (!row) return res.status(404).json({ error: "Customer not found" });

  const orders = await listOrdersForOwner("customer_id", id);
  const ledger = await wallet.getHistory("customer", id, { limit: 200 });

  res.json({ customer: serializeCustomerRow(row), orders, wallet_ledger: ledger });
}

/** PATCH /admin/customers/:id  body: { status: 'active'|'blocked' } */
async function updateCustomerStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!["active", "blocked"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'blocked'" });
  }
  const existing = await db("users").where({ id }).first();
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  await db("users").where({ id }).update({ status });
  res.json({ customer: await db("users").where({ id }).first() });
}

/**
 * POST /admin/customers/:id/wallet-credit  body: { amount, notes? }
 * Goodwill credit — the only way an admin adds Platter credits by hand.
 */
async function creditCustomerWallet(req, res) {
  const { id } = req.params;
  const { amount, notes } = req.body || {};
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > 100000) {
    return res.status(400).json({ error: "amount must be a positive number (up to 100000)" });
  }
  const customer = await db("users").where({ id }).first();
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const balance = await wallet.recordEntry({
    ownerType: "customer",
    ownerId: Number(id),
    entryType: "credit",
    amount: value,
    reason: "manual_adjustment",
    notes: notes ? String(notes).slice(0, 500) : `Admin credit (by admin #${req.auth.id})`,
  });
  res.json({ balance });
}

// ---- CSV export ----

// Prevents CSV/formula injection (a cell starting with = + - @ auto-executes
// as a formula in Excel/Sheets) and correctly quotes anything with a comma,
// quote or newline — this file is built from user-entered names/emails.
function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * GET /admin/customers/export.csv
 * Same filters as the list (including campaign ones), but a blocked customer
 * is excluded UNCONDITIONALLY — this file exists to be uploaded to a
 * marketing tool, so `status` is never honoured here even if passed.
 * Defaults promo_opt_in to "1" (opted-in only) unless explicitly overridden.
 */
async function exportCustomersCsv(req, res) {
  const params = { ...req.query, promo_opt_in: req.query.promo_opt_in ?? "1" };
  const { query, filterInJs } = applyCampaignFilters(customersWithOrderStats(), params, { forceActiveOnly: true });

  const rows = (await query.orderBy("u.created_at", "desc")).filter(filterInJs);

  const csv = toCsv(
    rows.map((r) => ({
      name: r.name || "",
      phone: r.phone,
      email: r.email || "",
      order_count: Number(r.order_count),
      total_spent: Number(r.total_spent),
      last_order_at: r.last_order_at || "",
      created_at: r.created_at,
    })),
    ["name", "phone", "email", "order_count", "total_spent", "last_order_at", "created_at"]
  );

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}

module.exports = { listCustomers, getCustomer, updateCustomerStatus, creditCustomerWallet, exportCustomersCsv };
