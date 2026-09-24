const db = require("../config/db");
const { normalizeCategoryName } = require("../utils/categoryName");

// Shown when a category has no prep-time of its own (kitchen-created ones start
// with none) so the customer app always has a "min-max min" to render.
const DEFAULT_PREP_MIN_MINUTES = 30;
const DEFAULT_PREP_MAX_MINUTES = 40;

/**
 * Every category (active and inactive) with its canonical key. The key is
 * always recomputed from the name rather than trusting categories.name_normalized:
 * the column exists as a race-safe unique backstop, but a NULL (unkeyed legacy
 * row) or a since-tightened normalization rule must never let a duplicate through.
 */
async function listAllWithKeys() {
  const rows = await db("categories").orderBy("name").select("id", "name", "is_active");
  return rows.map((c) => ({ id: c.id, name: c.name, is_active: Boolean(c.is_active), norm: normalizeCategoryName(c.name) }));
}

/**
 * The image_url of each category's first (lowest-id) active item that has one.
 * Kitchen-created categories have no image of their own, so the customer tile
 * borrows a dish photo instead of showing a blank. Returns Map<categoryId, url>.
 */
async function firstItemImageByCategory(categoryIds) {
  if (!categoryIds.length) return new Map();
  const rows = await db("items")
    .whereIn("category_id", categoryIds)
    .andWhere("is_active", true)
    .whereNotNull("image_url")
    .andWhere("image_url", "!=", "")
    .orderBy("id")
    .select("category_id", "image_url");
  const map = new Map();
  for (const r of rows) if (!map.has(r.category_id)) map.set(r.category_id, r.image_url);
  return map;
}

module.exports = { listAllWithKeys, firstItemImageByCategory, DEFAULT_PREP_MIN_MINUTES, DEFAULT_PREP_MAX_MINUTES };
