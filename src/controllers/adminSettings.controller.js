const db = require("../config/db");
const riderPay = require("../services/riderPay.service");

const MAX_AMOUNT = 100000;
const FIELDS = ["base_payout", "per_km_rate", "min_payout", "incentive_per_delivery"];

async function history(limit = 100) {
  const rows = await db("rider_pay_config as c")
    .leftJoin("admins as a", "a.id", "c.created_by_admin_id")
    .orderBy("c.id", "desc")
    .limit(limit)
    .select("c.*", "a.name as created_by_admin_name");
  return rows.map((r) => ({ ...riderPay.normalizeConfig(r), created_by_admin_name: r.created_by_admin_name || null }));
}

/**
 * GET /admin/settings/rider-pay — the live rider pay config, its formula, and the full
 * change history (newest first; the first row is the live one).
 */
async function getRiderPay(req, res) {
  const rows = await history();
  res.json({ settings: rows[0] || (await riderPay.getCurrentConfig()), formula: riderPay.FORMULA, history: rows });
}

/**
 * PUT /admin/settings/rider-pay { base_payout, per_km_rate, min_payout, incentive_per_delivery }
 * super_admin only. Appends a history row and makes it the live config. Applies to orders
 * delivered from now on — payouts already frozen on delivered orders never change.
 */
async function updateRiderPay(req, res) {
  const body = req.body || {};
  const values = {};
  for (const key of FIELDS) {
    const raw = body[key];
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) {
      return res.status(400).json({ error: `${key} must be a number from 0 to ${MAX_AMOUNT}` });
    }
    values[key] = Number(n.toFixed(2));
  }
  if (FIELDS.every((key) => values[key] === 0)) {
    return res.status(400).json({ error: "At least one of the pay values must be above 0 — riders would earn nothing" });
  }

  const [id] = await db("rider_pay_config").insert({ ...values, created_by_admin_id: req.auth.id });
  const rows = await history(1);
  res.json({ settings: rows[0], formula: riderPay.FORMULA, id });
}

module.exports = { getRiderPay, updateRiderPay };
