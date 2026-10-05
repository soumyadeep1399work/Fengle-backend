const db = require("../config/db");
const settlement = require("../services/settlement.service");
const { paginationParams } = require("../utils/pagination");
const { listOrdersForOwner } = require("./adminOrders.controller");
const storage = require("../services/storage.service");

// Never password_hash — every admin-facing rider read goes through this
// column list rather than select("*")/first() on the raw table.
const RIDER_PUBLIC_COLUMNS = [
  "id", "name", "phone", "vehicle_type", "vehicle_number", "wallet_balance",
  "last_known_lat", "last_known_lng", "status", "onboarded_via", "created_at", "updated_at",
];

/**
 * POST /admin/riders/:riderId/settle — manually triggers settlement for one
 * rider. No scheduled job exists yet (see settlement.service.js) — this is
 * the interim way to run daily/weekly settlement until that's automated.
 */
async function settleRider(req, res) {
  const { riderId } = req.params;
  const result = await settlement.settleRider(riderId);
  res.json(result);
}

/**
 * GET /admin/riders?page=&limit=&q=&status=
 * Per rider: COD liability outstanding (a negative wallet_balance IS the
 * liability — see wallet.service.js's "net of COD liability vs commission"
 * comment, so this is just its positive magnitude, 0 if the rider owes
 * nothing), unsettled delivered-order count, and last_active_at (riders.updated_at
 * — bumped by the availability toggle and location ping, so it's a real proxy
 * for "last seen", not literally "last delivery").
 */
async function listRiders(req, res) {
  if (req.query.status && !["active", "inactive", "suspended"].includes(req.query.status)) {
    return res.status(400).json({ error: "status must be 'active', 'inactive' or 'suspended'" });
  }
  const { page, limit, offset } = paginationParams(req);

  let query = db("riders");
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.q && req.query.q.trim()) {
    const term = `%${req.query.q.trim()}%`;
    query = query.andWhere((qb) => qb.where("name", "like", term).orWhere("phone", "like", term));
  }

  const { n: total } = await query.clone().count({ n: "*" }).first();
  const riders = await query
    .clone()
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .select(
      "id", "name", "phone", "status", "wallet_balance", "vehicle_type", "vehicle_number", "updated_at", "created_at",
      "agreement_accepted_at as agreementAcceptedAt", "agreement_version as agreementVersion",
      db.raw("(agreement_selfie_path is not null) as hasAgreementSelfie")
    );

  const riderIds = riders.map((r) => r.id);
  const unsettledRows = riderIds.length
    ? await db("orders").whereIn("rider_id", riderIds).andWhere({ status: "delivered" }).whereNull("rider_settled_at").select("rider_id").count({ n: "*" }).groupBy("rider_id")
    : [];
  const unsettledByRider = Object.fromEntries(unsettledRows.map((r) => [r.rider_id, Number(r.n)]));

  res.json({
    riders: riders.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, status: r.status,
      wallet_balance: Number(r.wallet_balance),
      cod_liability_outstanding: Number(r.wallet_balance) < 0 ? Number((-r.wallet_balance).toFixed(2)) : 0,
      unsettled_delivery_count: unsettledByRider[r.id] || 0,
      vehicle_type: r.vehicle_type, vehicle_number: r.vehicle_number,
      last_active_at: r.updated_at, created_at: r.created_at,
      agreementAcceptedAt: r.agreementAcceptedAt, agreementVersion: r.agreementVersion,
      hasAgreementSelfie: !!r.hasAgreementSelfie,
    })),
    page, limit, total: Number(total),
  });
}

/**
 * GET /admin/riders/:id — profile + wallet ledger + recent orders.
 * Explicit column list (never password_hash) on the rider row, and the
 * order rows come from the shared listOrdersForOwner helper — same shape as
 * GET /admin/orders rows, and it never selects delivery_otp.
 */
async function getRider(req, res) {
  const { id } = req.params;
  const rider = await db("riders")
    .where({ id })
    .select(
      ...RIDER_PUBLIC_COLUMNS, "agreement_accepted_at as agreementAcceptedAt", "agreement_version as agreementVersion",
      db.raw("(agreement_selfie_path is not null) as hasAgreementSelfie")
    )
    .first();
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  rider.hasAgreementSelfie = !!rider.hasAgreementSelfie;

  const walletLedger = await db("wallet_ledger").where({ owner_type: "rider", owner_id: id }).orderBy("created_at", "desc").limit(200);
  const orders = await listOrdersForOwner("rider_id", id);
  const [{ n: unsettled }] = await db("orders").where({ rider_id: id, status: "delivered" }).whereNull("rider_settled_at").count({ n: "*" });

  res.json({
    rider: {
      ...rider,
      wallet_balance: Number(rider.wallet_balance),
      cod_liability_outstanding: Number(rider.wallet_balance) < 0 ? Number((-rider.wallet_balance).toFixed(2)) : 0,
      unsettled_delivery_count: Number(unsettled),
    },
    wallet_ledger: walletLedger,
    orders,
  });
}

/**
 * GET /admin/riders/:id/agreement-selfie — admin-only, streams the raw image
 * bytes (never a public URL — see storage.service.js). 404 if this rider
 * never accepted in-app (exempt seed/dev rider, or not onboarded since the
 * feature shipped).
 */
async function getRiderAgreementSelfie(req, res) {
  const { id } = req.params;
  const rider = await db("riders").where({ id }).select("agreement_selfie_path").first();
  if (!rider || !rider.agreement_selfie_path) {
    return res.status(404).json({ error: "No agreement selfie on file" });
  }
  const { buffer, contentType } = await storage.readAgreementSelfie(rider.agreement_selfie_path);
  res.set("Content-Type", contentType);
  res.send(buffer);
}

/**
 * PATCH /admin/riders/:id  body: { status: 'active'|'inactive'|'suspended' }
 * A suspended rider is already blocked from new auto-assignment
 * (autoAssignRider only considers status:'active') and from logging back in
 * (auth.controller.js's verifyOtp) — this is just the toggle.
 */
async function updateRiderStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!["active", "inactive", "suspended"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active', 'inactive' or 'suspended'" });
  }
  const existing = await db("riders").where({ id }).select("id").first();
  if (!existing) return res.status(404).json({ error: "Rider not found" });

  await db("riders").where({ id }).update({ status });
  res.json({ rider: await db("riders").where({ id }).select(RIDER_PUBLIC_COLUMNS).first() });
}

/**
 * GET /admin/settlements?page=&limit=&rider_id=
 * Settlement history straight from the wallet ledger (settleRider only ever
 * writes 'settlement_payout'; 'settlement_deduction' is included too in case
 * that ever gets used for a separate deduction entry).
 */
async function listSettlements(req, res) {
  const { rider_id } = req.query;
  const { page, limit, offset } = paginationParams(req);

  let query = db("wallet_ledger as w").join("riders as r", "r.id", "w.owner_id").where("w.owner_type", "rider").whereIn("w.reason", ["settlement_payout", "settlement_deduction"]);
  if (rider_id) query = query.andWhere("w.owner_id", rider_id);

  const { n: total } = await query.clone().count({ n: "w.id" }).first();
  const rows = await query.clone().orderBy("w.created_at", "desc").limit(limit).offset(offset).select("w.*", "r.name as rider_name", "r.phone as rider_phone");

  res.json({
    settlements: rows.map((r) => ({ ...r, amount: Number(r.amount), balance_after: Number(r.balance_after) })),
    page, limit, total: Number(total),
  });
}

/**
 * GET /admin/dashboard
 * GMV = sum of grand_total on DELIVERED orders only (realized revenue, not
 * everything ever placed). last7Days includes today and runs oldest-first.
 */
async function dashboardSummary(req, res) {
  const [{ totalOrders }] = await db("orders").count({ totalOrders: "*" });
  const [{ pendingOrders }] = await db("orders").whereIn("status", ["placed", "accepted", "picked_up", "on_the_way"]).count({ pendingOrders: "*" });

  const statusRows = await db("orders").select("status").count({ n: "*" }).groupBy("status");
  const statusCounts = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)]));

  const restaurantStatusRows = await db("restaurants").select("status").count({ n: "*" }).groupBy("status");
  const restaurantsByStatus = Object.fromEntries(restaurantStatusRows.map((r) => [r.status, Number(r.n)]));
  const riderStatusRows = await db("riders").select("status").count({ n: "*" }).groupBy("status");
  const ridersByStatus = Object.fromEntries(riderStatusRows.map((r) => [r.status, Number(r.n)]));

  const gmvExpr = "COALESCE(SUM(CASE WHEN status = 'delivered' THEN grand_total ELSE 0 END), 0)";
  const today = await db("orders")
    .whereRaw("DATE(created_at) = CURDATE()")
    .select(db.raw("COUNT(*) as orders"), db.raw(`${gmvExpr} as gmv`))
    .first();

  const seriesRows = await db("orders")
    .whereRaw("created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)")
    .groupByRaw("DATE_FORMAT(created_at, '%Y-%m-%d')")
    .select(db.raw("DATE_FORMAT(created_at, '%Y-%m-%d') as date"), db.raw("COUNT(*) as orders"), db.raw(`${gmvExpr} as gmv`));
  const seriesByDate = Object.fromEntries(seriesRows.map((r) => [r.date, { orders: Number(r.orders), gmv: Number(r.gmv) }]));

  // Zero-fill all 7 days (oldest first) rather than only the ones with
  // orders — a chart expects a fixed-length series, not one that shrinks on
  // a quiet day. Built in JS off the server's own clock so it always lines
  // up with the CURDATE()-based query above.
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const point = seriesByDate[date] || { orders: 0, gmv: 0 };
    last7Days.push({ date, orders: point.orders, gmv: point.gmv });
  }

  res.json({
    totalOrders: Number(totalOrders),
    pendingOrders: Number(pendingOrders),
    activeRestaurants: restaurantsByStatus.active || 0,
    activeRiders: ridersByStatus.active || 0,
    statusCounts,
    restaurantsByStatus,
    ridersByStatus,
    today: { orders: Number(today.orders), gmv: Number(today.gmv) },
    last7Days,
  });
}

module.exports = {
  settleRider, listRiders, getRider, updateRiderStatus, listSettlements,
  dashboardSummary, getRiderAgreementSelfie,
};
