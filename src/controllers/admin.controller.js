const db = require("../config/db");
const settlement = require("../services/settlement.service");

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

async function listRiders(req, res) {
  const riders = await db("riders").select(
    "id", "name", "phone", "status", "wallet_balance", "vehicle_type", "vehicle_number", "created_at"
  );
  res.json({ riders });
}

async function dashboardSummary(req, res) {
  const [{ totalOrders }] = await db("orders").count({ totalOrders: "*" });
  const [{ activeRestaurants }] = await db("restaurants").where({ status: "active" }).count({ activeRestaurants: "*" });
  const [{ activeRiders }] = await db("riders").where({ status: "active" }).count({ activeRiders: "*" });
  const [{ pendingOrders }] = await db("orders").whereIn("status", ["placed", "accepted", "picked_up", "on_the_way"]).count({ pendingOrders: "*" });

  res.json({ totalOrders, activeRestaurants, activeRiders, pendingOrders });
}

async function listAllOrders(req, res) {
  const { status } = req.query;
  let query = db("orders").orderBy("created_at", "desc").limit(200);
  if (status) query = query.where({ status });
  const orders = await query;
  res.json({ orders });
}

module.exports = { settleRider, listRiders, dashboardSummary, listAllOrders };
