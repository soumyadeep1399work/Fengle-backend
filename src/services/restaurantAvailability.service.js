const db = require("../config/db");
const { presentHours } = require("../utils/serviceHours");

/**
 * A kitchen's own Online / Offline switch (restaurants.is_online). It combines with the admin-set daily hours in
 * utils/serviceHours.js: a kitchen takes orders only when it is online AND inside its hours.
 */

/**
 * Sets the switch. A real change writes a restaurant_availability_history row; setting the state it already has changes nothing.
 * Returns true if it changed.
 */
async function setOnline(restaurantId, online, { changedBy, adminId = null }) {
  return db.transaction(async (trx) => {
    const row = await trx("restaurants").where({ id: restaurantId }).forUpdate().select("is_online").first();
    if (!row || Boolean(row.is_online) === online) return false;
    await trx("restaurants").where({ id: restaurantId }).update({ is_online: online });
    await trx("restaurant_availability_history").insert({ restaurant_id: restaurantId, is_online: online, changed_by: changedBy, admin_id: adminId });
    return true;
  });
}

/** The availability fields on GET /restaurants/me: online (the switch), the hours as "HH:MM", is_open_now (hours rule), accepting_orders (both). */
function presentForKitchen(row) {
  const h = presentHours(row);
  return { online: h.is_online, opens_at: h.opens_at, closes_at: h.closes_at, is_open_now: h.is_open_now, accepting_orders: h.accepting_orders };
}

/** When a kitchen went online/offline, newest first (admin view). */
async function historyFor(conn, restaurantId, limit = 30) {
  const rows = await conn("restaurant_availability_history").where({ restaurant_id: restaurantId }).orderBy("id", "desc").limit(limit);
  return rows.map((r) => ({ id: r.id, is_online: Boolean(r.is_online), changed_by: r.changed_by, admin_id: r.admin_id, created_at: r.created_at }));
}

module.exports = { setOnline, presentForKitchen, historyFor };
