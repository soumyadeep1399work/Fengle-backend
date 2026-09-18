const db = require("../config/db");

async function listFavorites(req, res) {
  const favorites = await db("favorites")
    .join("items", "items.id", "favorites.item_id")
    .where("favorites.customer_id", req.auth.id)
    .andWhere("items.is_active", true)
    .select("items.id", "items.name", "items.description", "items.price", "items.image_url", "items.is_veg", "items.category_id");
  res.json({ favorites });
}

/**
 * POST /favorites/:itemId — idempotent: favoriting an already-favorited item
 * just returns success rather than a 409, since the client has no reason to
 * treat that as an error (e.g. a double-tap on the heart icon).
 */
async function addFavorite(req, res) {
  const { itemId } = req.params;
  const item = await db("items").where({ id: itemId, is_active: true }).first();
  if (!item) return res.status(404).json({ error: "Item not found" });

  const existing = await db("favorites").where({ customer_id: req.auth.id, item_id: itemId }).first();
  if (!existing) {
    await db("favorites").insert({ customer_id: req.auth.id, item_id: itemId });
  }
  res.status(201).json({ message: "Added to favorites" });
}

async function removeFavorite(req, res) {
  const { itemId } = req.params;
  await db("favorites").where({ customer_id: req.auth.id, item_id: itemId }).delete();
  res.json({ message: "Removed from favorites" });
}

module.exports = { listFavorites, addFavorite, removeFavorite };
