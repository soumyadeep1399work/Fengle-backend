const db = require("../config/db");
const riderPay = require("../services/riderPay.service");

// Rider pay is now an admin-managed shipping RULE set (kind rider_pay, /admin/shipping/rules). This old endpoint is kept as a
// read-only view of the simple shape (for older screens) plus the legacy single-config history; it can no longer change anything.

async function history(limit = 100) {
  const rows = await db("rider_pay_config as c")
    .leftJoin("admins as a", "a.id", "c.created_by_admin_id")
    .orderBy("c.id", "desc")
    .limit(limit)
    .select("c.*", "a.name as created_by_admin_name");
  return rows.map((r) => ({ ...riderPay.normalizeConfig(r), created_by_admin_name: r.created_by_admin_name || null }));
}

/**
 * GET /admin/settings/rider-pay — the live rider pay in the old single-config shape, ONLY while the rider rules really are that
 * simple (`simple: true`); otherwise `settings` is null and `simple` false (see /admin/shipping/rules?kind=rider_pay for the real
 * thing). `history` is the legacy single-config change log (read-only, from before the rules engine).
 */
async function getRiderPay(req, res) {
  const simple = await riderPay.simpleConfig();
  res.json({
    settings: simple ? { id: null, ...simple, created_at: null, created_by_admin_id: null } : null,
    simple: Boolean(simple),
    formula: riderPay.FORMULA,
    history: await history(),
    managed_at: "/admin/shipping/rules?kind=rider_pay",
  });
}

/** PUT /admin/settings/rider-pay — retired: rider pay is managed under /admin/shipping/rules (kind rider_pay). */
async function updateRiderPay(req, res) {
  res.status(410).json({ error: "Rider pay is managed under /admin/shipping/rules (kind rider_pay)", code: "moved_to_shipping_rules" });
}

const supportContact = require("../services/supportContact.service");

/** GET /admin/settings/support-contact -> { phone, whatsapp, email, hours, source: "admin" | "env", updated_at, updated_by } (what the apps show right now) */
async function getSupportContact(req, res) {
  res.json(await supportContact.current());
}

/**
 * PUT /admin/settings/support-contact { phone, whatsapp, email, hours } (super_admin) -> the same shape. All four keys are required (null or ""
 * hides one). Once saved the saved values are what the apps show: a cleared field stays hidden, it does not fall back to the server env.
 */
async function updateSupportContact(req, res) {
  const v = supportContact.validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  await supportContact.save(v.value, req.auth.id);
  res.json(await supportContact.current());
}

module.exports = { getRiderPay, updateRiderPay, getSupportContact, updateSupportContact };
