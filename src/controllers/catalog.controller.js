const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");

const CATALOG_RANGE_KM = 7; // matches the cascade ceiling in routing.service.js — never show an item that couldn't actually route
const GLOBAL_MIN_ORDER_VALUE = 50; // keep in sync with order.controller.js's MIN_ORDER_VALUE

const ITEM_COLUMNS = ["items.id", "items.name", "items.description", "items.price", "items.image_url", "items.is_veg", "items.category_id"];

/**
 * Restaurants within catalog-visibility range of a location, optionally
 * narrowed to ones serving a specific category. Shared by every
 * location-filtered catalog read (category items, category detail, search)
 * so they all agree on what "nearby" means.
 */
async function getInRangeRestaurantIds(lat, lng, categoryId) {
  let query = db("restaurants").where("restaurants.status", "active");
  if (categoryId) {
    query = query
      .join("restaurant_categories", "restaurants.id", "restaurant_categories.restaurant_id")
      .andWhere("restaurant_categories.category_id", categoryId);
  }
  const restaurants = await query.select("restaurants.id", "restaurants.lat", "restaurants.lng");
  return restaurants
    .filter((r) => haversineDistanceKm(Number(lat), Number(lng), Number(r.lat), Number(r.lng)) <= CATALOG_RANGE_KM)
    .map((r) => r.id);
}

/**
 * Batch-computes { avgRating, ratingCount } per item from delivered orders'
 * restaurant_rating — there's no per-item rating submission anywhere in the
 * API, so an item's rating reflects how customers rated the kitchen(s) that
 * actually cooked it (consistent with "customer never sees restaurant
 * identity, only category/item" — the rating still has to live somewhere).
 * Returns a Map<item_id, {avgRating, ratingCount}>; items with no rated
 * deliveries yet are simply absent from the map (caller defaults them).
 */
async function getRatingsByItemId(itemIds) {
  if (!itemIds.length) return new Map();
  const rows = await db("order_items")
    .join("orders", "orders.id", "order_items.order_id")
    .whereIn("order_items.item_id", itemIds)
    .andWhere("orders.status", "delivered")
    .whereNotNull("orders.restaurant_rating")
    .groupBy("order_items.item_id")
    .select("order_items.item_id")
    .avg({ avgRating: "orders.restaurant_rating" })
    .count({ ratingCount: "orders.restaurant_rating" });

  const map = new Map();
  for (const row of rows) {
    map.set(row.item_id, { avgRating: Number(Number(row.avgRating).toFixed(1)), ratingCount: Number(row.ratingCount) });
  }
  return map;
}

async function attachRatings(items) {
  const ratings = await getRatingsByItemId(items.map((i) => i.id));
  return items.map((item) => ({
    ...item,
    avgRating: ratings.has(item.id) ? ratings.get(item.id).avgRating : null,
    ratingCount: ratings.has(item.id) ? ratings.get(item.id).ratingCount : 0,
  }));
}

// ---- Categories (Admin only to create — categories are platform-level, not per-restaurant) ----

/**
 * GET /categories
 * Includes clubPartnerIds — other categories that share at least one active
 * restaurant with this one anywhere on the platform. This is a discovery
 * hint only (e.g. "Bengali usually clubs with Mughlai") — the real,
 * location-aware clubbing decision for a specific cart happens at
 * POST /cart/quote, which actually runs the routing engine.
 */
async function listCategories(req, res) {
  const categories = await db("categories").where({ is_active: true }).orderBy("name");

  const pairs = await db("restaurant_categories as rc1")
    .join("restaurant_categories as rc2", "rc1.restaurant_id", "rc2.restaurant_id")
    .whereRaw("rc1.category_id != rc2.category_id")
    .distinct("rc1.category_id as category_id", "rc2.category_id as partner_id");

  const partnersByCategory = new Map();
  for (const { category_id, partner_id } of pairs) {
    if (!partnersByCategory.has(category_id)) partnersByCategory.set(category_id, []);
    partnersByCategory.get(category_id).push(partner_id);
  }

  res.json({
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      blurb: c.description,
      image_url: c.image_url,
      prepTimeMinMinutes: c.prep_time_min_minutes,
      prepTimeMaxMinutes: c.prep_time_max_minutes,
      minOrder: c.min_order_override != null ? Number(c.min_order_override) : GLOBAL_MIN_ORDER_VALUE,
      clubPartnerIds: partnersByCategory.get(c.id) || [],
    })),
  });
}

async function createCategory(req, res) {
  const { name, description, image_url, prep_time_min_minutes, prep_time_max_minutes, min_order_override } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const [id] = await db("categories").insert({
    name, description, image_url,
    prep_time_min_minutes: prep_time_min_minutes || null,
    prep_time_max_minutes: prep_time_max_minutes || null,
    min_order_override: min_order_override != null ? min_order_override : null,
  });
  const category = await db("categories").where({ id }).first();
  res.status(201).json({ category });
}

/**
 * GET /categories/:id?lat=&lng=
 * Full category detail for the Category screen: category header info plus
 * items split into "Popular" (top-rated/most-ordered) and "More" sections,
 * matching the flatboard's POPULAR/MORE grouping.
 */
async function getCategoryDetail(req, res) {
  const { id } = req.params;
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng query params are required" });

  const category = await db("categories").where({ id, is_active: true }).first();
  if (!category) return res.status(404).json({ error: "Category not found" });

  const inRangeRestaurantIds = await getInRangeRestaurantIds(lat, lng, id);
  let items = [];
  if (inRangeRestaurantIds.length > 0) {
    items = await db("items")
      .join("restaurant_items", "items.id", "restaurant_items.item_id")
      .whereIn("restaurant_items.restaurant_id", inRangeRestaurantIds)
      .andWhere("restaurant_items.is_available", true)
      .andWhere("items.category_id", id)
      .andWhere("items.is_active", true)
      .groupBy(...ITEM_COLUMNS)
      .select(ITEM_COLUMNS);
  }

  const itemsWithRatings = await attachRatings(items);
  const sorted = [...itemsWithRatings].sort((a, b) => (b.ratingCount - a.ratingCount) || (b.avgRating || 0) - (a.avgRating || 0));
  const popular = sorted.slice(0, 3);
  const popularIds = new Set(popular.map((i) => i.id));
  const more = sorted.filter((i) => !popularIds.has(i.id));

  res.json({
    category: {
      id: category.id,
      name: category.name,
      blurb: category.description,
      image_url: category.image_url,
      prepTimeMinMinutes: category.prep_time_min_minutes,
      prepTimeMaxMinutes: category.prep_time_max_minutes,
      minOrder: category.min_order_override != null ? Number(category.min_order_override) : GLOBAL_MIN_ORDER_VALUE,
    },
    sections: [
      { title: "Popular", items: popular },
      { title: "More", items: more },
    ],
  });
}

/**
 * GET /categories/:categoryId/items?lat=&lng=
 * Older flat-list shape, kept alongside GET /categories/:id for anything
 * that just wants items without the sectioned/detail wrapper.
 */
async function listItemsForCategory(req, res) {
  const { categoryId } = req.params;
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "lat and lng query params are required" });
  }

  const inRangeRestaurantIds = await getInRangeRestaurantIds(lat, lng, categoryId);
  if (inRangeRestaurantIds.length === 0) {
    return res.json({ items: [] });
  }

  const items = await db("items")
    .join("restaurant_items", "items.id", "restaurant_items.item_id")
    .whereIn("restaurant_items.restaurant_id", inRangeRestaurantIds)
    .andWhere("restaurant_items.is_available", true)
    .andWhere("items.category_id", categoryId)
    .andWhere("items.is_active", true)
    .groupBy(...ITEM_COLUMNS)
    .select(ITEM_COLUMNS);

  res.json({ items: await attachRatings(items) });
}

/**
 * GET /items/search?q=&veg=&lat=&lng=
 * Same location-visibility rule as category browsing, just across every
 * category at once and filtered by a name/description match.
 */
async function searchItems(req, res) {
  const { q, veg, lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng query params are required" });
  if (!q || !q.trim()) return res.status(400).json({ error: "q is required" });

  const inRangeRestaurantIds = await getInRangeRestaurantIds(lat, lng);
  if (inRangeRestaurantIds.length === 0) return res.json({ items: [] });

  let query = db("items")
    .join("restaurant_items", "items.id", "restaurant_items.item_id")
    .whereIn("restaurant_items.restaurant_id", inRangeRestaurantIds)
    .andWhere("restaurant_items.is_available", true)
    .andWhere("items.is_active", true)
    .andWhere((qb) => qb.where("items.name", "like", `%${q}%`).orWhere("items.description", "like", `%${q}%`));

  if (veg === "true" || veg === "1") {
    query = query.andWhere("items.is_veg", true);
  }

  const items = await query.groupBy(...ITEM_COLUMNS).select(ITEM_COLUMNS);
  res.json({ items: await attachRatings(items) });
}

/**
 * POST /items — creates a catalog item. Restaurants may only create items in
 * categories they're approved for; Admin can create in any category.
 */
async function createItem(req, res) {
  const { category_id, name, description, price, image_url, is_veg } = req.body;
  const { id: actorId, type } = req.auth;

  if (!category_id || !name || price == null) {
    return res.status(400).json({ error: "category_id, name and price are required" });
  }
  if (type !== "admin" && type !== "restaurant") {
    return res.status(403).json({ error: "Only admin or restaurant accounts can create items" });
  }

  if (type === "restaurant") {
    const approved = await db("restaurant_categories")
      .where({ restaurant_id: actorId, category_id })
      .first();
    if (!approved) {
      return res.status(403).json({ error: "This restaurant is not approved for that category" });
    }
  }

  const [id] = await db("items").insert({
    category_id,
    name,
    description,
    price,
    image_url,
    is_veg: Boolean(is_veg),
    created_by_type: type,
    created_by_restaurant_id: type === "restaurant" ? actorId : null,
  });

  // A restaurant creating an item implicitly has it in stock at their own kitchen.
  if (type === "restaurant") {
    await db("restaurant_items").insert({ restaurant_id: actorId, item_id: id, is_available: true });
  }

  const item = await db("items").where({ id }).first();
  res.status(201).json({ item });
}

/**
 * PATCH /restaurants/:restaurantId/items/:itemId/availability
 * The one-tap stock toggle from the Restaurant Portal design.
 */
async function setItemAvailability(req, res) {
  const { restaurantId, itemId } = req.params;
  const { is_available } = req.body;
  const { id: actorId, type } = req.auth;

  if (type !== "restaurant" || Number(actorId) !== Number(restaurantId)) {
    return res.status(403).json({ error: "Not authorized to update this restaurant's stock" });
  }

  const existing = await db("restaurant_items").where({ restaurant_id: restaurantId, item_id: itemId }).first();
  if (existing) {
    await db("restaurant_items").where({ id: existing.id }).update({ is_available: Boolean(is_available) });
  } else {
    await db("restaurant_items").insert({ restaurant_id: restaurantId, item_id: itemId, is_available: Boolean(is_available) });
  }

  res.json({ message: "Availability updated" });
}

module.exports = {
  listCategories,
  createCategory,
  getCategoryDetail,
  listItemsForCategory,
  searchItems,
  createItem,
  setItemAvailability,
  getInRangeRestaurantIds, // reused by cart.controller.js for the quote/clubbing check
};
