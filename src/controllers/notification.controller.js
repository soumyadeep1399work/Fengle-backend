const db = require("../config/db");

const DEFAULT_NOTIFICATION_PREFS = { order_updates: true, promotions: true };

/**
 * POST /notifications/register-device — customer, restaurant or rider
 * body: { token, platform: 'android'|'ios' } (token = Expo push token)
 * Upserts so re-registering the same token (app reinstall, token refresh
 * fired twice) never errors — device_tokens has a unique(owner_type,
 * owner_id, token) constraint backing this. A phone belongs to whoever is
 * logged in on it now, so the token is first removed from any other account
 * (otherwise a shared or re-used phone keeps getting the old account's pushes).
 */
async function registerDevice(req, res) {
  const { token, platform } = req.body;
  const { type: ownerType, id: ownerId } = req.auth;
  if (!token || typeof token !== "string" || token.length > 255 || !["android", "ios"].includes(platform)) {
    return res.status(400).json({ error: "token and platform ('android'|'ios') are required" });
  }

  await db("device_tokens")
    .where({ token })
    .andWhere((qb) => qb.whereNot("owner_type", ownerType).orWhereNot("owner_id", ownerId))
    .delete();

  const existing = await db("device_tokens").where({ owner_type: ownerType, owner_id: ownerId, token }).first();
  if (existing) {
    await db("device_tokens").where({ id: existing.id }).update({ platform });
  } else {
    await db("device_tokens").insert({ owner_type: ownerType, owner_id: ownerId, token, platform });
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
