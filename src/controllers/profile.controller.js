const db = require("../config/db");

const DEFAULT_NOTIFICATION_PREFS = { order_updates: true, promotions: true };

function serializeProfile(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    photo_url: row.photo_url,
    veg_only: Boolean(row.veg_only),
    wallet_balance: Number(row.wallet_balance),
    notification_prefs: row.notification_prefs
      ? (typeof row.notification_prefs === "string" ? JSON.parse(row.notification_prefs) : row.notification_prefs)
      : DEFAULT_NOTIFICATION_PREFS,
  };
}

async function getMyProfile(req, res) {
  const row = await db("users").where({ id: req.auth.id }).first();
  if (!row) return res.status(404).json({ error: "Profile not found" });
  res.json({ profile: serializeProfile(row) });
}

/**
 * PATCH /profile/me
 * body: any of { name, email, photo_url }
 * Phone is intentionally not editable here — it's the OTP login identity.
 */
async function updateMyProfile(req, res) {
  const { name, email, photo_url } = req.body;
  const updates = {};
  if (name != null) updates.name = name;
  if (email != null) updates.email = email;
  if (photo_url != null) updates.photo_url = photo_url;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  await db("users").where({ id: req.auth.id }).update(updates);
  const row = await db("users").where({ id: req.auth.id }).first();
  res.json({ profile: serializeProfile(row) });
}

/**
 * PATCH /profile/preferences
 * body: { veg_only }
 */
async function updatePreferences(req, res) {
  const { veg_only } = req.body;
  if (veg_only == null) {
    return res.status(400).json({ error: "veg_only is required" });
  }
  await db("users").where({ id: req.auth.id }).update({ veg_only: Boolean(veg_only) });
  const row = await db("users").where({ id: req.auth.id }).first();
  res.json({ profile: serializeProfile(row) });
}

/**
 * PATCH /profile/default-address
 * body: { address_id }
 * Thin alias over the address CRUD's own is_default flip (PATCH
 * /addresses/:id already does this) — kept as its own route since the
 * Customer App's profile screen models "default address" as a profile
 * action, not an address-editing one.
 */
async function setDefaultAddress(req, res) {
  const { address_id } = req.body;
  if (!address_id) return res.status(400).json({ error: "address_id is required" });

  const address = await db("addresses").where({ id: address_id, customer_id: req.auth.id }).first();
  if (!address) return res.status(404).json({ error: "Address not found" });

  await db.transaction(async (trx) => {
    await trx("addresses").where({ customer_id: req.auth.id }).update({ is_default: false });
    await trx("addresses").where({ id: address_id }).update({ is_default: true });
  });

  const addresses = await db("addresses").where({ customer_id: req.auth.id }).orderBy([{ column: "is_default", order: "desc" }, { column: "created_at", order: "asc" }]);
  res.json({ addresses });
}

module.exports = { getMyProfile, updateMyProfile, updatePreferences, setDefaultAddress };
