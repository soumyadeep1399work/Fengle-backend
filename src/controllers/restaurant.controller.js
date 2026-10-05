const db = require("../config/db");
const { normalizeCategoryName, findSimilar, validateCategoryName } = require("../utils/categoryName");
const categoryService = require("../services/category.service");
const { paginationParams } = require("../utils/pagination");
const { CURRENT_AGREEMENT_VERSION, agreementRequired } = require("../utils/agreement");
const storage = require("../services/storage.service");

// Never password_hash — every admin-facing restaurant read goes through this
// column list rather than select("*")/first() on the raw table.
const RESTAURANT_PUBLIC_COLUMNS = [
  "id", "name", "owner_name", "phone", "email", "address", "lat", "lng",
  "radius_km", "commission_rate_percent", "status", "onboarded_by", "created_at", "updated_at",
];

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

    return trx("restaurants").where({ id: restaurantId }).select(RESTAURANT_PUBLIC_COLUMNS).first();
  });

  res.status(201).json({ restaurant: result });
}

/** GET /admin/restaurants?page=&limit= — each row includes its order_count. */
async function listRestaurants(req, res) {
  const { page, limit, offset } = paginationParams(req);

  const { n: total } = await db("restaurants").count({ n: "*" }).first();
  const restaurants = await db("restaurants")
    .select(
      ...RESTAURANT_PUBLIC_COLUMNS, "agreement_accepted_at as agreementAcceptedAt", "agreement_version as agreementVersion",
      db.raw("(agreement_selfie_path is not null) as hasAgreementSelfie")
    )
    .orderBy("name")
    .limit(limit)
    .offset(offset);

  const ids = restaurants.map((r) => r.id);
  const orderCountRows = ids.length ? await db("orders").whereIn("restaurant_id", ids).select("restaurant_id").count({ n: "*" }).groupBy("restaurant_id") : [];
  const orderCountById = Object.fromEntries(orderCountRows.map((r) => [r.restaurant_id, Number(r.n)]));

  res.json({
    restaurants: restaurants.map((r) => ({ ...r, hasAgreementSelfie: !!r.hasAgreementSelfie, order_count: orderCountById[r.id] || 0 })),
    page, limit, total: Number(total),
  });
}

/**
 * PATCH /admin/restaurants/:id — radius, commission rate, and status are all
 * admin-configurable at any time per the confirmed business rules.
 */
async function updateRestaurant(req, res) {
  const { id } = req.params;
  const { radius_km, commission_rate_percent, status, name, address, lat, lng } = req.body;

  if (status && !["active", "inactive", "suspended"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active', 'inactive' or 'suspended'" });
  }

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

  const restaurant = await db("restaurants").where({ id }).select(RESTAURANT_PUBLIC_COLUMNS).first();
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

/** DELETE /admin/restaurants/:id/categories/:categoryId */
async function removeRestaurantCategory(req, res) {
  const { id, categoryId } = req.params;
  const deleted = await db("restaurant_categories").where({ restaurant_id: id, category_id: categoryId }).delete();
  if (!deleted) return res.status(404).json({ error: "This restaurant does not serve that category" });
  res.json({ message: "Category removed" });
}

/**
 * GET /admin/restaurants/:id — detail: categories, order count, average
 * rating (from delivered orders' restaurant_rating, same source item ratings
 * use), and commission-rate change history.
 */
async function getRestaurantDetail(req, res) {
  const { id } = req.params;
  const restaurant = await db("restaurants")
    .where({ id })
    .select(
      ...RESTAURANT_PUBLIC_COLUMNS, "agreement_accepted_at as agreementAcceptedAt", "agreement_version as agreementVersion",
      db.raw("(agreement_selfie_path is not null) as hasAgreementSelfie")
    )
    .first();
  if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });
  restaurant.hasAgreementSelfie = !!restaurant.hasAgreementSelfie;

  const categories = await db("restaurant_categories")
    .join("categories", "categories.id", "restaurant_categories.category_id")
    .where("restaurant_categories.restaurant_id", id)
    .orderBy("categories.name")
    .select("categories.id", "categories.name");

  const [{ n: orderCount }] = await db("orders").where({ restaurant_id: id }).count({ n: "*" });
  const ratingRow = await db("orders")
    .where({ restaurant_id: id })
    .whereNotNull("restaurant_rating")
    .select(db.raw("AVG(restaurant_rating) as avg"), db.raw("COUNT(*) as n"))
    .first();

  const commissionHistory = await db("commission_config_history").where({ restaurant_id: id }).orderBy("created_at", "desc");

  res.json({
    restaurant,
    categories,
    order_count: Number(orderCount),
    rating: { avg: ratingRow.avg != null ? Number(Number(ratingRow.avg).toFixed(1)) : null, count: Number(ratingRow.n) },
    commission_config_history: commissionHistory,
  });
}

/**
 * GET /restaurants/me — the logged-in restaurant's own profile for the
 * Restaurant app's Profile tab (/auth/session only carries id/phone/name).
 * Never returns password_hash; commission and radius are admin-managed and
 * deliberately not exposed here.
 */
async function getMyRestaurant(req, res) {
  const restaurant = await db("restaurants").where({ id: req.auth.id }).first();
  if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

  const categories = await db("restaurant_categories")
    .join("categories", "categories.id", "restaurant_categories.category_id")
    .where("restaurant_categories.restaurant_id", restaurant.id)
    .orderBy("categories.name")
    .select("categories.id", "categories.name");

  res.json({
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      owner_name: restaurant.owner_name,
      phone: restaurant.phone,
      email: restaurant.email,
      address: restaurant.address,
      status: restaurant.status,
      categories,
      agreementRequired: agreementRequired(restaurant),
    },
  });
}

/**
 * POST /restaurants/me/accept-agreement — multipart/form-data, field `selfie`
 * (jpeg/png/webp, 2MB cap — see selfieUpload.middleware.js) + field
 * `agreement_version` (the version the app is showing; 409 if it doesn't
 * match CURRENT_AGREEMENT_VERSION, so a stale app build can't accept an
 * outdated version). agreement_accepted_at is always the server's own clock,
 * never anything the client sends.
 */
async function acceptRestaurantAgreement(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "A selfie file is required (multipart/form-data, field name 'selfie')" });
  }
  const version = Number(req.body.agreement_version);
  if (!Number.isInteger(version)) {
    return res.status(400).json({ error: "agreement_version is required and must be an integer" });
  }
  if (version !== CURRENT_AGREEMENT_VERSION) {
    return res.status(409).json({ error: `agreement_version mismatch — current version is ${CURRENT_AGREEMENT_VERSION}` });
  }

  const ext = storage.detectImageType(req.file.buffer);
  if (!ext) {
    return res.status(400).json({ error: "Only JPEG, PNG or WebP images are accepted" });
  }

  const selfiePath = await storage.saveAgreementSelfie(req.file.buffer, ext);
  const acceptedAt = new Date();
  await db("restaurants").where({ id: req.auth.id }).update({
    agreement_accepted_at: acceptedAt,
    agreement_version: version,
    agreement_selfie_path: selfiePath,
  });

  res.json({ agreementAcceptedAt: acceptedAt.toISOString() });
}

/**
 * GET /admin/restaurants/:id/agreement-selfie — admin-only, streams the raw
 * image bytes (never a public URL — see storage.service.js). 404 if this
 * restaurant never accepted in-app (exempt seed/dev rows, or not onboarded
 * since the feature shipped).
 */
async function getRestaurantAgreementSelfie(req, res) {
  const { id } = req.params;
  const restaurant = await db("restaurants").where({ id }).select("agreement_selfie_path").first();
  if (!restaurant || !restaurant.agreement_selfie_path) {
    return res.status(404).json({ error: "No agreement selfie on file" });
  }
  const { buffer, contentType } = await storage.readAgreementSelfie(restaurant.agreement_selfie_path);
  res.set("Content-Type", contentType);
  res.send(buffer);
}

/**
 * GET /restaurants/me/menu — every active item in the restaurant's approved
 * categories, INCLUDING ones currently switched off. The customer-facing
 * catalog hides unavailable items, so this is the only place a restaurant can
 * see an item to switch it back on. A missing restaurant_items row counts as
 * not available, matching routing.service.js ("no row = not in stock").
 */
async function getMyMenu(req, res) {
  const rows = await db("items")
    .join("restaurant_categories", "restaurant_categories.category_id", "items.category_id")
    .join("categories", "categories.id", "items.category_id")
    .leftJoin("restaurant_items", function () {
      this.on("restaurant_items.item_id", "=", "items.id").andOn("restaurant_items.restaurant_id", "=", db.raw("?", [req.auth.id]));
    })
    .where("restaurant_categories.restaurant_id", req.auth.id)
    .andWhere("items.is_active", true)
    .orderBy([{ column: "categories.name" }, { column: "items.id" }])
    .select(
      "items.id", "items.name", "items.description", "items.price", "items.image_url", "items.is_veg",
      "items.category_id", "categories.name as category_name", "restaurant_items.is_available"
    );

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      price: Number(r.price),
      image_url: r.image_url,
      is_veg: Boolean(r.is_veg),
      category_id: r.category_id,
      category_name: r.category_name,
      is_available: Boolean(r.is_available),
    })),
  });
}

// ---------------------------------------------------------------------------
// Kitchens managing their own categories (no admin approval — product decision
// 2026-09-21). The safeguard is duplicate prevention, enforced HERE on the
// server; the app's own checks are only UX. See utils/categoryName.js.
// ---------------------------------------------------------------------------

const categoryShape = (c, joinedIds) => ({ id: c.id, name: c.name, joined: joinedIds.has(c.id) });

async function joinedCategoryIds(restaurantId) {
  const rows = await db("restaurant_categories").where({ restaurant_id: restaurantId }).select("category_id");
  return new Set(rows.map((r) => r.category_id));
}

/**
 * GET /restaurants/me/category-options?q=
 * The picker's data: every active category (or those containing q) with
 * whether this kitchen has joined it, plus — when q is given — the exact match
 * and up to 5 close matches ("Momo" vs typed "Momos"). Independent of the
 * customer catalog, so it keeps working if empty categories are hidden there.
 */
async function getCategoryOptions(req, res) {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
  const active = (await categoryService.listAllWithKeys()).filter((c) => c.is_active);
  const joined = await joinedCategoryIds(req.auth.id);

  let categories = active;
  let exact = null;
  let similar = [];
  if (q) {
    const key = normalizeCategoryName(q);
    const needle = q.toLowerCase();
    categories = active.filter((c) => c.name.toLowerCase().includes(needle) || (key && c.norm.includes(key)));
    if (key) {
      const match = active.find((c) => c.norm === key);
      exact = match ? categoryShape(match, joined) : null;
      similar = findSimilar(key, active).map((c) => categoryShape(c, joined));
    }
  }

  res.json({ categories: categories.map((c) => categoryShape(c, joined)), exact, similar });
}

/**
 * POST /restaurants/me/categories
 *   { category_id }                         join an existing category
 *   { name, confirm_not_duplicate? }        create a new one and join it
 * Creating never bypasses the duplicate check: an exact match (same
 * normalized name) is always refused with a pointer to the existing category;
 * a merely close match is refused until the app resends with
 * confirm_not_duplicate: true (i.e. the kitchen looked at the suggestions).
 */
async function addMyCategory(req, res) {
  const restaurantId = req.auth.id;
  const { category_id, name, confirm_not_duplicate } = req.body || {};

  if (category_id !== undefined && name !== undefined) {
    return res.status(400).json({ error: "Send either category_id (join existing) or name (create new), not both" });
  }

  // ---- (a) join an existing category ----
  if (category_id !== undefined) {
    const id = Number(category_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "category_id must be a positive integer" });

    const category = await db("categories").where({ id, is_active: true }).first();
    if (!category) return res.status(404).json({ error: "Category not found" });

    const already = await db("restaurant_categories").where({ restaurant_id: restaurantId, category_id: id }).first();
    if (already) {
      return res.status(409).json({ code: "already_joined", error: `You already have "${category.name}"`, category: { id: category.id, name: category.name } });
    }
    await db("restaurant_categories").insert({ restaurant_id: restaurantId, category_id: id });
    return res.status(201).json({ category: { id: category.id, name: category.name } });
  }

  // ---- (b) create a new category ----
  if (name === undefined) {
    return res.status(400).json({ error: "Send category_id (join an existing category) or name (create a new one)" });
  }
  const validated = validateCategoryName(name);
  if (validated.error) return res.status(400).json({ code: "invalid_name", error: validated.error });

  const all = await categoryService.listAllWithKeys();
  const joined = await joinedCategoryIds(restaurantId);
  const respondExact = (exact) =>
    exact.is_active
      ? res.status(409).json({
          code: "category_exists",
          error: `"${exact.name}" already exists — join it instead of creating a new one`,
          category: categoryShape(exact, joined),
        })
      : res.status(409).json({
          code: "category_unavailable",
          error: `"${exact.name}" exists but has been disabled — ask the platform team`,
          category: { id: exact.id, name: exact.name },
        });

  const exact = all.find((c) => c.norm === validated.normalized);
  if (exact) return respondExact(exact);

  const similar = findSimilar(validated.normalized, all.filter((c) => c.is_active));
  if (similar.length > 0 && confirm_not_duplicate !== true) {
    return res.status(409).json({
      code: "similar_categories",
      error: "Similar categories already exist — join one of them, or confirm this is genuinely different",
      similar: similar.map((c) => categoryShape(c, joined)),
    });
  }

  // Nothing here is reviewed by an admin, so cap how many one kitchen can make —
  // a buggy client loop must not be able to flood the shared customer catalog.
  const cap = Number(process.env.MAX_CATEGORIES_PER_RESTAURANT) || 10;
  const [{ made }] = await db("categories").where({ created_by_restaurant_id: restaurantId }).count({ made: "*" });
  if (Number(made) >= cap) {
    return res.status(403).json({ code: "category_limit", error: `You can create up to ${cap} new categories — join an existing one instead` });
  }

  let created;
  try {
    created = await db.transaction(async (trx) => {
      const [id] = await trx("categories").insert({
        name: validated.name,
        name_normalized: validated.normalized,
        description: null,
        image_url: null,
        prep_time_min_minutes: null,
        prep_time_max_minutes: null,
        min_order_override: null,
        is_active: true,
        created_by_restaurant_id: restaurantId,
      });
      await trx("restaurant_categories").insert({ restaurant_id: restaurantId, category_id: id });
      return { id, name: validated.name };
    });
  } catch (err) {
    // Two kitchens submitting the same new name at once: the unique indexes
    // (name / name_normalized) let exactly one win; the loser gets the same
    // friendly "already exists" answer as if it had arrived a moment later.
    if (err.code === "ER_DUP_ENTRY") {
      const fresh = (await categoryService.listAllWithKeys()).find((c) => c.norm === validated.normalized);
      if (fresh) return respondExact(fresh);
    }
    throw err;
  }
  return res.status(201).json({ category: created });
}

module.exports = {
  onboardRestaurant, listRestaurants, updateRestaurant, addRestaurantCategory, removeRestaurantCategory, getRestaurantDetail,
  getMyRestaurant, getMyMenu, getCategoryOptions, addMyCategory,
  acceptRestaurantAgreement, getRestaurantAgreementSelfie,
};
