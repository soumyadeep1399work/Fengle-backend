const db = require("../config/db");

/**
 * POST /admin/restaurants — the ONLY way a restaurant enters the system.
 * There is no restaurant self-registration endpoint anywhere (confirmed rule,
 * also enforced in auth.controller.js's OTP verify flow).
 */
async function onboardRestaurant(req, res) {
  const {
    name, owner_name, phone, email, address, lat, lng,
    radius_km, commission_rate_percent, category_ids,
  } = req.body;

  if (!name || !phone || !address || lat == null || lng == null) {
    return res.status(400).json({ error: "name, phone, address, lat and lng are required" });
  }
  if (!Array.isArray(category_ids) || category_ids.length === 0) {
    return res.status(400).json({ error: "At least one category_id is required" });
  }

  const result = await db.transaction(async (trx) => {
    const [restaurantId] = await trx("restaurants").insert({
      name,
      owner_name,
      phone,
      email,
      address,
      lat,
      lng,
      radius_km: radius_km || 5.0,
      commission_rate_percent: commission_rate_percent || 15.0,
      status: "active",
    });

    await trx("restaurant_categories").insert(
      category_ids.map((categoryId) => ({ restaurant_id: restaurantId, category_id: categoryId }))
    );

    return trx("restaurants").where({ id: restaurantId }).first();
  });

  res.status(201).json({ restaurant: result });
}

async function listRestaurants(req, res) {
  const restaurants = await db("restaurants").select("*").orderBy("name");
  res.json({ restaurants });
}

/**
 * PATCH /admin/restaurants/:id — radius, commission rate, and status are all
 * admin-configurable at any time per the confirmed business rules.
 */
async function updateRestaurant(req, res) {
  const { id } = req.params;
  const { radius_km, commission_rate_percent, status, name, address, lat, lng } = req.body;

  const updates = {};
  if (radius_km != null) updates.radius_km = radius_km;
  if (commission_rate_percent != null) updates.commission_rate_percent = commission_rate_percent;
  if (status) updates.status = status;
  if (name) updates.name = name;
  if (address) updates.address = address;
  if (lat != null) updates.lat = lat;
  if (lng != null) updates.lng = lng;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  await db("restaurants").where({ id }).update(updates);

  // Keep a history row for commission changes so past orders' commission_amount
  // can always be explained by the rate that applied at the time (schema note).
  if (commission_rate_percent != null) {
    await db("commission_config_history").insert({
      restaurant_id: id,
      rate_percent: commission_rate_percent,
      changed_by_admin_id: req.auth.id,
    });
  }

  const restaurant = await db("restaurants").where({ id }).first();
  res.json({ restaurant });
}

async function addRestaurantCategory(req, res) {
  const { id } = req.params;
  const { category_id } = req.body;

  const existing = await db("restaurant_categories").where({ restaurant_id: id, category_id }).first();
  if (existing) return res.status(409).json({ error: "Restaurant already serves this category" });

  await db("restaurant_categories").insert({ restaurant_id: id, category_id });
  res.status(201).json({ message: "Category added" });
}

module.exports = { onboardRestaurant, listRestaurants, updateRestaurant, addRestaurantCategory };
