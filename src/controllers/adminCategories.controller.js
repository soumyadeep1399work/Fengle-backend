const db = require("../config/db");
const { normalizeCategoryName, validateCategoryName } = require("../utils/categoryName");
const categoryService = require("../services/category.service");
const { paginationParams } = require("../utils/pagination");

/**
 * GET /admin/categories?page=&limit= — every category, active or not, with
 * item_count, restaurant_count and who created it (null = admin/seed).
 */
async function listCategories(req, res) {
  const { page, limit, offset } = paginationParams(req);

  const { n: total } = await db("categories").count({ n: "*" }).first();

  const rows = await db("categories as c")
    .leftJoin("items as i", "i.category_id", "c.id")
    .leftJoin("restaurant_categories as rc", "rc.category_id", "c.id")
    .leftJoin("restaurants as r", "r.id", "c.created_by_restaurant_id")
    .groupBy("c.id")
    .orderBy("c.name")
    .limit(limit)
    .offset(offset)
    .select(
      "c.*",
      db.raw("COUNT(DISTINCT i.id) as item_count"),
      db.raw("COUNT(DISTINCT rc.restaurant_id) as restaurant_count"),
      "r.name as created_by_restaurant_name"
    );

  res.json({
    page, limit, total: Number(total),
    categories: rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      image_url: c.image_url,
      is_active: Boolean(c.is_active),
      prep_time_min_minutes: c.prep_time_min_minutes,
      prep_time_max_minutes: c.prep_time_max_minutes,
      min_order_override: c.min_order_override != null ? Number(c.min_order_override) : null,
      item_count: Number(c.item_count),
      restaurant_count: Number(c.restaurant_count),
      created_by_restaurant_id: c.created_by_restaurant_id,
      created_by_restaurant_name: c.created_by_restaurant_name,
      created_at: c.created_at,
    })),
  });
}

/**
 * PATCH /admin/categories/:id
 * body: any of { name, is_active, description, image_url, prep_time_min_minutes, prep_time_max_minutes, min_order_override }
 * A rename goes through the same duplicate check kitchens are held to — an
 * admin renaming "Momo" to "Biryani" must not silently create a collision
 * with the real Biryani category.
 */
async function updateCategory(req, res) {
  const { id } = req.params;
  const { name, is_active, description, image_url, prep_time_min_minutes, prep_time_max_minutes, min_order_override } = req.body || {};

  const category = await db("categories").where({ id }).first();
  if (!category) return res.status(404).json({ error: "Category not found" });

  const updates = {};
  if (name !== undefined) {
    const validated = validateCategoryName(name);
    if (validated.error) return res.status(400).json({ code: "invalid_name", error: validated.error });
    if (validated.normalized !== category.name_normalized) {
      const all = await categoryService.listAllWithKeys();
      const clash = all.find((c) => c.id !== Number(id) && c.norm === validated.normalized);
      if (clash) {
        return res.status(409).json({ code: "category_exists", error: `"${clash.name}" already uses that name`, category: { id: clash.id, name: clash.name } });
      }
    }
    updates.name = validated.name;
    updates.name_normalized = validated.normalized;
  }
  if (is_active !== undefined) {
    if (typeof is_active !== "boolean") return res.status(400).json({ error: "is_active must be true or false" });
    updates.is_active = is_active;
  }
  if (description !== undefined) {
    if (description !== null && (typeof description !== "string" || description.length > 255)) {
      return res.status(400).json({ error: "description must be a string of at most 255 characters, or null" });
    }
    updates.description = description;
  }
  if (image_url !== undefined) {
    if (image_url !== null && (typeof image_url !== "string" || image_url.length > 500 || !/^https?:\/\//i.test(image_url))) {
      return res.status(400).json({ error: "image_url must be an http(s) URL of at most 500 characters, or null" });
    }
    updates.image_url = image_url;
  }
  for (const [field, value] of [["prep_time_min_minutes", prep_time_min_minutes], ["prep_time_max_minutes", prep_time_max_minutes]]) {
    if (value !== undefined) {
      if (value !== null && (!Number.isInteger(value) || value <= 0 || value > 300)) {
        return res.status(400).json({ error: `${field} must be a positive integer (minutes), or null` });
      }
      updates[field] = value;
    }
  }
  if (min_order_override !== undefined) {
    if (min_order_override !== null && (typeof min_order_override !== "number" || !Number.isFinite(min_order_override) || min_order_override < 0)) {
      return res.status(400).json({ error: "min_order_override must be a non-negative number, or null" });
    }
    updates.min_order_override = min_order_override;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  await db("categories").where({ id }).update(updates);
  res.json({ category: await db("categories").where({ id }).first() });
}

/**
 * POST /admin/categories/:id/merge  body: { into_category_id }
 * The "Momo vs Momos" cleanup CLAUDE.md assigns to the Admin Panel: moves
 * every item and every restaurant's serving-relationship from the source
 * category to the target, then deactivates the source (never deleted — past
 * orders still reference it by id, and order_items.category_id is a
 * historical snapshot that is deliberately NOT rewritten here, same
 * principle as the item-name snapshot: merging changes what's orderable
 * going forward, not what a past order says it was at the time).
 */
async function mergeCategories(req, res) {
  const { id } = req.params;
  const { into_category_id } = req.body || {};
  if (!into_category_id || Number(into_category_id) === Number(id)) {
    return res.status(400).json({ error: "into_category_id is required and must differ from :id" });
  }

  const source = await db("categories").where({ id }).first();
  const target = await db("categories").where({ id: into_category_id }).first();
  if (!source || !target) return res.status(404).json({ error: "Category not found" });
  if (!target.is_active) return res.status(400).json({ error: "Cannot merge into an inactive category" });

  await db.transaction(async (trx) => {
    await trx("items").where({ category_id: id }).update({ category_id: into_category_id });

    const linkedRestaurants = await trx("restaurant_categories").where({ category_id: id }).select("restaurant_id");
    for (const { restaurant_id } of linkedRestaurants) {
      const alreadyHasTarget = await trx("restaurant_categories").where({ restaurant_id, category_id: into_category_id }).first();
      if (alreadyHasTarget) {
        await trx("restaurant_categories").where({ restaurant_id, category_id: id }).delete();
      } else {
        await trx("restaurant_categories").where({ restaurant_id, category_id: id }).update({ category_id: into_category_id });
      }
    }

    await trx("categories").where({ id }).update({ is_active: false });
  });

  res.json({ merged_into: await db("categories").where({ id: into_category_id }).first() });
}

/** GET /admin/items?category_id=&q= — includes inactive items. */
/** GET /admin/items?category_id=&q=&page=&limit= — includes inactive items. */
async function listItems(req, res) {
  const { category_id, q } = req.query;
  const { page, limit, offset } = paginationParams(req);

  let base = db("items as i");
  if (category_id) base = base.where("i.category_id", category_id);
  if (q && q.trim()) base = base.andWhere((qb) => qb.where("i.name", "like", `%${q.trim()}%`).orWhere("i.description", "like", `%${q.trim()}%`));

  const { n: total } = await base.clone().count({ n: "i.id" }).first();
  const rows = await base
    .clone()
    .join("categories as c", "c.id", "i.category_id")
    .orderBy(["c.name", "i.name"])
    .limit(limit)
    .offset(offset)
    .select("i.*", "c.name as category_name");

  res.json({
    page, limit, total: Number(total),
    items: rows.map((r) => ({
      id: r.id, name: r.name, description: r.description, price: Number(r.price), image_url: r.image_url,
      is_veg: Boolean(r.is_veg), is_active: Boolean(r.is_active), category_id: r.category_id, category_name: r.category_name,
      created_by_type: r.created_by_type, created_by_restaurant_id: r.created_by_restaurant_id, created_at: r.created_at,
    })),
  });
}

module.exports = { listCategories, updateCategory, mergeCategories, listItems };
