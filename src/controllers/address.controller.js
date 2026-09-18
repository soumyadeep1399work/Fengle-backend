const db = require("../config/db");

// Saved addresses for the Customer App's Addresses screen. Orders snapshot
// delivery_lat/delivery_lng/delivery_address directly (see order.controller.js),
// so these rows are just a picker list — never referenced by past orders.

async function listMyAddresses(req, res) {
  const addresses = await db("addresses")
    .where({ customer_id: req.auth.id })
    .orderBy([{ column: "is_default", order: "desc" }, { column: "created_at", order: "asc" }]);
  res.json({ addresses });
}

/**
 * POST /addresses
 * body: { label, address_line, lat, lng, is_default? }
 * The first address a customer saves is always the default, regardless of
 * what's passed, so there's never a customer with saved addresses and no default.
 */
async function createAddress(req, res) {
  const { label, address_line, lat, lng, is_default } = req.body;
  const customerId = req.auth.id;

  if (!label || !address_line || lat == null || lng == null) {
    return res.status(400).json({ error: "label, address_line, lat and lng are required" });
  }

  await db.transaction(async (trx) => {
    const existingCount = await trx("addresses").where({ customer_id: customerId }).count({ count: "*" }).first();
    const shouldBeDefault = Number(existingCount.count) === 0 || Boolean(is_default);

    if (shouldBeDefault) {
      await trx("addresses").where({ customer_id: customerId }).update({ is_default: false });
    }

    await trx("addresses").insert({
      customer_id: customerId,
      label,
      address_line,
      lat,
      lng,
      is_default: shouldBeDefault,
    });
  });

  const addresses = await db("addresses").where({ customer_id: customerId }).orderBy([{ column: "is_default", order: "desc" }, { column: "created_at", order: "asc" }]);
  res.status(201).json({ addresses });
}

/**
 * PATCH /addresses/:id
 * body: any of { label, address_line, lat, lng, is_default }
 */
async function updateAddress(req, res) {
  const { id } = req.params;
  const { label, address_line, lat, lng, is_default } = req.body;
  const customerId = req.auth.id;

  const existing = await db("addresses").where({ id, customer_id: customerId }).first();
  if (!existing) return res.status(404).json({ error: "Address not found" });

  const updates = {};
  if (label != null) updates.label = label;
  if (address_line != null) updates.address_line = address_line;
  if (lat != null) updates.lat = lat;
  if (lng != null) updates.lng = lng;

  if (Object.keys(updates).length === 0 && is_default == null) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  await db.transaction(async (trx) => {
    if (is_default === true) {
      await trx("addresses").where({ customer_id: customerId }).update({ is_default: false });
      updates.is_default = true;
    }
    if (Object.keys(updates).length > 0) {
      await trx("addresses").where({ id }).update(updates);
    }
  });

  const address = await db("addresses").where({ id }).first();
  res.json({ address });
}

/**
 * DELETE /addresses/:id
 * If the deleted address was the default and others remain, the
 * most-recently-added one becomes the new default — there's always a
 * default when at least one address exists.
 */
async function deleteAddress(req, res) {
  const { id } = req.params;
  const customerId = req.auth.id;

  const existing = await db("addresses").where({ id, customer_id: customerId }).first();
  if (!existing) return res.status(404).json({ error: "Address not found" });

  await db.transaction(async (trx) => {
    await trx("addresses").where({ id }).delete();

    if (existing.is_default) {
      const next = await trx("addresses").where({ customer_id: customerId }).orderBy("created_at", "desc").first();
      if (next) {
        await trx("addresses").where({ id: next.id }).update({ is_default: true });
      }
    }
  });

  res.json({ message: "Address deleted" });
}

module.exports = { listMyAddresses, createAddress, updateAddress, deleteAddress };
