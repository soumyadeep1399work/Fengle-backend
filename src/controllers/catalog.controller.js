const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");
const { normalizeCategoryName } = require("../utils/categoryName");
const categoryService = require("../services/category.service");

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
 * Public shape of a category. Always returns usable values, because
 * kitchen-created categories have no description/photo/prep time of their own:
 * prep time falls back to a global default, minOrder to the global minimum,
 * and the photo to the first dish photo in the category (else null — the
 * client shows a placeholder). blurb stays null when there is none.
 */
function serializeCategory(c, { imageFallback, clubPartnerIds } = {}) {
  const hasOwnPrep = c.prep_time_min_minutes != null && c.prep_time_max_minutes != null;
  return {
    id: c.id,
    name: c.name,
    blurb: c.description,
    image_url: c.image_url || (imageFallback && imageFallback.get(c.id)) || null,
    prepTimeMinMinutes: hasOwnPrep ? c.prep_time_min_minutes : categoryService.DEFAULT_PREP_MIN_MINUTES,
    prepTimeMaxMinutes: hasOwnPrep ? c.prep_time_max_minutes : categoryService.DEFAULT_PREP_MAX_MINUTES,
    minOrder: c.min_order_override != null ? Number(c.min_order_override) : GLOBAL_MIN_ORDER_VALUE,
    ...(clubPartnerIds ? { clubPartnerIds } : {}),
  };
}

/**
 * Ids of categories with at least one available, active item at an active
 * kitchen within range of a location — the same visibility rule
 * getCategoryDetail uses, computed for all categories in one query.
 */
async function getCategoryIdsWithStock(lat, lng) {
  const inRangeRestaurantIds = await getInRangeRestaurantIds(lat, lng);
  if (inRangeRestaurantIds.length === 0) return new Set();
  const rows = await db("restaurant_categories as rc")
    .join("items as i", "i.category_id", "rc.category_id")
    .join("restaurant_items as ri", function () {
      this.on("ri.item_id", "=", "i.id").andOn("ri.restaurant_id", "=", "rc.restaurant_id");
    })
    .whereIn("rc.restaurant_id", inRangeRestaurantIds)
    .andWhere("ri.is_available", true)
    .andWhere("i.is_active", true)
    .distinct("rc.category_id");
  return new Set(rows.map((r) => r.category_id));
}

/**
 * GET /categories[?lat=&lng=]
 * Without coordinates: every active category (unchanged behaviour).
 * With both: only categories that actually have something to order nearby —
 * a brand-new kitchen-created category with nothing in stock would otherwise
 * show as an empty tile. Passing only one of lat/lng is a 400.
 *
 * clubPartnerIds = other categories sharing at least one active restaurant
 * platform-wide — a discovery hint only; the real location-aware club
 * decision is POST /cart/quote. When filtering by location the hint is
 * filtered to the categories actually returned.
 */
async function listCategories(req, res) {
  const { lat, lng } = req.query;
  const located = lat !== undefined || lng !== undefined;
  const isCoord = (v) => typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
  if (located && !(isCoord(lat) && isCoord(lng))) {
    return res.status(400).json({ error: "lat and lng must both be valid numbers" });
  }

  let categories = await db("categories").where({ is_active: true }).orderBy("name");
  if (located) {
    const visible = await getCategoryIdsWithStock(lat, lng);
    categories = categories.filter((c) => visible.has(c.id));
  }
  const shownIds = new Set(categories.map((c) => c.id));

  const pairs = await db("restaurant_categories as rc1")
    .join("restaurant_categories as rc2", "rc1.restaurant_id", "rc2.restaurant_id")
    .whereRaw("rc1.category_id != rc2.category_id")
    .distinct("rc1.category_id as category_id", "rc2.category_id as partner_id");

  const partnersByCategory = new Map();
  for (const { category_id, partner_id } of pairs) {
    if (located && !shownIds.has(partner_id)) continue;
    if (!partnersByCategory.has(category_id)) partnersByCategory.set(category_id, []);
    partnersByCategory.get(category_id).push(partner_id);
  }

  const imageFallback = await categoryService.firstItemImageByCategory(categories.filter((c) => !c.image_url).map((c) => c.id));
  res.json({
    categories: categories.map((c) => serializeCategory(c, { imageFallback, clubPartnerIds: partnersByCategory.get(c.id) || [] })),
  });
}

async function createCategory(req, res) {
  const { name, description, image_url, prep_time_min_minutes, prep_time_max_minutes, min_order_override } = req.body;
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });

  // Same "it will only show one, not two" rule kitchens are held to: an exact
  // duplicate ("Momos" when "Momo" exists) is refused for admins too. Admins
  // aren't given the fuzzy warning or the kitchens' strict character rules
  // (seeded names like "Thali / Combos" need them).
  const key = normalizeCategoryName(name);
  if (!key) return res.status(400).json({ error: "name is too generic — say which cuisine or kind of dish it is" });
  const existing = (await categoryService.listAllWithKeys()).find((cat) => cat.norm === key);
  if (existing) {
    return res.status(409).json({
      code: "category_exists",
      error: `"${existing.name}" already exists`,
      category: { id: existing.id, name: existing.name },
    });
  }

  const [id] = await db("categories").insert({
    name: name.trim(), name_normalized: key, description, image_url,
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
    category: serializeCategory(category, {
      imageFallback: await categoryService.firstItemImageByCategory(category.image_url ? [] : [category.id]),
    }),
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
 * GET /items/popular?lat=&lng=&limit=6
 * Cross-category "Popular picks" for Home: same location filter as every
 * other catalog read, ranked by rating count then average. Items with no
 * ratings yet tie on that, so ties are broken by each item's position within
 * its own category (every category's first item before any category's
 * second) — that keeps a brand-new catalog showing a spread of categories
 * instead of six items from whichever category has the lowest ids.
 */
async function getPopularItems(req, res) {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng query params are required" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 50);

  const inRangeRestaurantIds = await getInRangeRestaurantIds(lat, lng);
  if (inRangeRestaurantIds.length === 0) return res.json({ items: [] });

  const items = await db("items")
    .join("restaurant_items", "items.id", "restaurant_items.item_id")
    .whereIn("restaurant_items.restaurant_id", inRangeRestaurantIds)
    .andWhere("restaurant_items.is_available", true)
    .andWhere("items.is_active", true)
    .groupBy(...ITEM_COLUMNS)
    .orderBy("items.id")
    .select(ITEM_COLUMNS);

  const rated = await attachRatings(items);

  const positionInCategory = new Map();
  const seenPerCategory = {};
  for (const item of rated) {
    seenPerCategory[item.category_id] = (seenPerCategory[item.category_id] || 0);
    positionInCategory.set(item.id, seenPerCategory[item.category_id]++);
  }

  rated.sort(
    (a, b) =>
      (b.ratingCount - a.ratingCount) ||
      ((b.avgRating || 0) - (a.avgRating || 0)) ||
      (positionInCategory.get(a.id) - positionInCategory.get(b.id)) ||
      (a.id - b.id)
  );

  res.json({ items: rated.slice(0, limit) });
}

/**
 * Shared by POST /items and PATCH /items/:id so the two can never drift apart
 * (this is a system boundary: restaurants type these values in). partial=false
 * is create — name and price are required; partial=true is edit — only the
 * fields actually present are validated. Returns { error } or { fields } with
 * cleaned values for just the columns that were provided.
 */
function validateItemFields(body, { partial }) {
  const fields = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has("name")) {
    const { name } = body;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 150) {
      return { error: "name must be a non-empty string of at most 150 characters" };
    }
    fields.name = name.trim();
  }
  if (!partial || has("price")) {
    // Numbers, or numeric strings like "250.50" — but never booleans, arrays, null, "" or "abc".
    const { price } = body;
    const value = typeof price === "string" && price.trim() !== "" ? Number(price) : price;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100000) {
      return { error: "price must be a positive number (up to 100000)" };
    }
    fields.price = Number(value.toFixed(2));
  }
  if (has("is_veg")) {
    // Strict boolean: Boolean("false") would silently turn a non-veg dish veg.
    if (typeof body.is_veg !== "boolean") return { error: "is_veg must be true or false" };
    fields.is_veg = body.is_veg;
  }
  if (has("description")) {
    const { description } = body;
    if (description !== null && (typeof description !== "string" || description.length > 255)) {
      return { error: "description must be a string of at most 255 characters" };
    }
    fields.description = description || null;
  }
  if (has("image_url")) {
    const { image_url } = body;
    if (image_url !== null && image_url !== "" &&
        (typeof image_url !== "string" || image_url.length > 500 || !/^https?:\/\//i.test(image_url))) {
      return { error: "image_url must be an http(s) URL of at most 500 characters" };
    }
    fields.image_url = image_url || null; // null / "" removes the photo
  }
  return { fields };
}

/**
 * PATCH /items/:id — edit name, price, is_veg, image_url (or description).
 * Decision (2026-09-21): a restaurant may edit ANY item its categories carry,
 * including admin-seeded ones, knowing the item is shared — the change shows
 * for every kitchen and every customer. Deliberately no ownership check
 * beyond "your restaurant carries this item's category" (the same rule
 * GET /restaurants/me/menu uses). category_id can never change: it would
 * break routing and reclassify order history.
 *
 * Existing orders keep their money: order_items snapshots unit_price/subtotal
 * and orders stores item_total/tax/grand_total at placement. What DOES follow
 * an edit is display data joined live from items — the item's name/photo as
 * shown on past orders. Prices for NEW orders use the edited price.
 */
async function updateItem(req, res) {
  const { id } = req.params;
  const { id: actorId, type } = req.auth;
  const body = req.body || {};

  // Restaurants only ever act on live items; admin also needs to find an
  // already-hidden item in order to un-hide it.
  const item = await db("items").where({ id }).modify((qb) => { if (type !== "admin") qb.andWhere("is_active", true); }).first();
  if (!item) return res.status(404).json({ error: "Item not found" });

  if (type === "restaurant") {
    const carries = await db("restaurant_categories").where({ restaurant_id: actorId, category_id: item.category_id }).first();
    if (!carries) return res.status(403).json({ error: "This restaurant does not carry that item's category" });
  }

  // Echoing back the current category is harmless (an app may send the whole
  // object); actually changing it is not allowed.
  if (body.category_id !== undefined && Number(body.category_id) !== Number(item.category_id)) {
    return res.status(400).json({ error: "category_id cannot be changed" });
  }

  const EDITABLE = ["name", "price", "is_veg", "image_url", "description"];
  if (type === "admin" && body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") return res.status(400).json({ error: "is_active must be true or false" });
  } else if (body.is_active !== undefined) {
    return res.status(403).json({ error: "Only admin can change is_active" });
  }
  const editableKeys = type === "admin" ? [...EDITABLE, "is_active"] : EDITABLE;
  if (!editableKeys.some((key) => body[key] !== undefined)) {
    return res.status(400).json({ error: `Send at least one of: ${editableKeys.join(", ")}` });
  }

  const validated = validateItemFields(body, { partial: true });
  if (validated.error) return res.status(400).json({ error: validated.error });
  if (type === "admin" && body.is_active !== undefined) validated.fields.is_active = body.is_active;

  await db("items").where({ id }).update({ ...validated.fields, updated_at: db.fn.now() });
  res.json({ item: await db("items").where({ id }).first() });
}

/**
 * POST /items — creates a catalog item. Restaurants may only create items in
 * categories they're approved for; Admin can create in any category.
 */
async function createItem(req, res) {
  const { category_id, name, price } = req.body;
  const { id: actorId, type } = req.auth;

  if (!category_id || !name || price == null) {
    return res.status(400).json({ error: "category_id, name and price are required" });
  }
  if (type !== "admin" && type !== "restaurant") {
    return res.status(403).json({ error: "Only admin or restaurant accounts can create items" });
  }

  const validated = validateItemFields(req.body, { partial: false });
  if (validated.error) return res.status(400).json({ error: validated.error });
  const fields = validated.fields;

  const category = await db("categories").where({ id: category_id, is_active: true }).first();
  if (!category) {
    return res.status(404).json({ error: "Category not found" });
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
    name: fields.name,
    description: fields.description || null,
    price: fields.price,
    image_url: fields.image_url || null,
    is_veg: fields.is_veg === true,
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
  getPopularItems,
  createItem,
  updateItem,
  setItemAvailability,
  getInRangeRestaurantIds, // reused by cart.controller.js for the quote/clubbing check
};
