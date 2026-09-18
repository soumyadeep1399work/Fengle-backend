const db = require("../config/db");

/**
 * PATCH /riders/me/availability
 * body: { status: 'active' | 'inactive' }
 * The online/offline toggle from the Rider Portal design.
 */
async function setAvailability(req, res) {
  const { status } = req.body;
  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
  }
  await db("riders").where({ id: req.auth.id }).update({ status });
  res.json({ message: `Rider marked ${status}` });
}

/**
 * PATCH /riders/me/location
 * body: { lat, lng }
 * Foreground-only location ping (see CLAUDE.md — no continuous background
 * GPS tracking in Phase 1). Called while the rider has an active delivery
 * open, purely to keep last_known_lat/lng fresh for the next auto-assignment.
 */
async function updateLocation(req, res) {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) {
    return res.status(400).json({ error: "lat and lng are required" });
  }
  await db("riders").where({ id: req.auth.id }).update({ last_known_lat: lat, last_known_lng: lng });
  res.json({ message: "Location updated" });
}

async function getMyAssignedOrders(req, res) {
  const orders = await db("orders")
    .where({ rider_id: req.auth.id })
    .whereIn("status", ["accepted", "picked_up", "on_the_way"])
    .orderBy("created_at", "desc");
  res.json({ orders });
}

module.exports = { setAvailability, updateLocation, getMyAssignedOrders };
