const db = require("../config/db");

const DEFAULT_NOTIFICATION_PREFS = { order_updates: true, promotions: true };

/**
 * POST /notifications/register-device
 * body: { token, platform: 'android'|'ios' }
 * Upserts so re-registering the same token (app reinstall, token refresh
 * fired twice) never errors — device_tokens has a unique(owner_type,
 * owner_id, token) constraint backing this.
 */
async function registerDevice(req, res) {
  const { token, platform } = req.body;
  if (!token || !["android", "ios"].includes(platform)) {
    return res.status(400).json({ error: "token and platform ('android'|'ios') are required" });
  }

  const existing = await db("device_tokens").where({ owner_type: "customer", owner_id: req.auth.id, token }).first();
  if (existing) {
    await db("device_tokens").where({ id: existing.id }).update({ platform });
  } else {
    await db("device_tokens").insert({ owner_type: "customer", owner_id: req.auth.id, token, platform });
  }
  res.status(201).json({ message: "Device registered" });
}

/**
 * PATCH /notifications/settings
 * body: any of { order_updates, promotions } — merges into the existing
 * prefs rather than requiring the full object each time.
 */
async function updateSettings(req, res) {
  const { order_updates, promotions } = req.body;
  if (order_updates == null && promotions == null) {
    return res.status(400).json({ error: "At least one of order_updates or promotions is required" });
  }

  const user = await db("users").where({ id: req.auth.id }).first();
  const current = user.notification_prefs
    ? (typeof user.notification_prefs === "string" ? JSON.parse(user.notification_prefs) : user.notification_prefs)
    : DEFAULT_NOTIFICATION_PREFS;

  const updated = {
    order_updates: order_updates != null ? Boolean(order_updates) : current.order_updates,
    promotions: promotions != null ? Boolean(promotions) : current.promotions,
  };

  await db("users").where({ id: req.auth.id }).update({ notification_prefs: JSON.stringify(updated) });
  res.json({ notification_prefs: updated });
}

module.exports = { registerDevice, updateSettings };
