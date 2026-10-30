const db = require("../config/db");
const { haversineDistanceKm } = require("../utils/geo");
const { applyDocumentsGate } = require("./partnerDocuments.service");
const { isOpenNow, openStatus } = require("../utils/serviceHours");

const CASCADE_CEILING_KM = 7; // hard outer search limit, per confirmed business rule
const DEFAULT_DELIVERY_RATE_PER_KM = 5; // ₹/km beyond a restaurant's own free radius

/**
 * Finds candidate restaurants for a cart, ranked nearest-first, annotated with
 * which requested items each candidate is missing from stock.
 *
 * Handles both single-category orders and clubbed orders (2 categories) —
 * a candidate restaurant must serve EVERY category present in the cart to
 * qualify at all (this is what makes clubbing possible: only restaurants
 * serving both categories show up as candidates for a clubbed cart).
 *
 * @param {object} params
 * @param {Array<{itemId:number, categoryId:number}>} params.items - deduplicated cart items
 * @param {number} params.customerLat
 * @param {number} params.customerLng
 * @param {boolean} [params.includeClosed] - default false: kitchens outside their service hours are skipped, so a cascade/reject
 *   moves on to the next OPEN kitchen. Only the "is the closest answer just closed?" check passes true.
 * @returns {Promise<Array<{restaurant:object, distanceKm:number, missingItemIds:number[]}>>}
 */
async function findCandidates({ items, customerLat, customerLng, includeClosed = false }) {
  const categoryIds = [...new Set(items.map((i) => i.categoryId))];

  if (categoryIds.length > 2) {
    // Should never happen if the app enforces the category-lock UI, but the
    // backend must not trust the client — reject defensively.
    const err = new Error("An order cannot span more than 2 categories");
    err.status = 400;
    throw err;
  }

  // Restaurants that serve EVERY category in this cart (join count must equal
  // categoryIds.length — this is the clubbing eligibility check).
  const restaurants = await db("restaurants")
    .join("restaurant_categories", "restaurants.id", "restaurant_categories.restaurant_id")
    .whereIn("restaurant_categories.category_id", categoryIds)
    .andWhere("restaurants.status", "active")
    .andWhere("restaurants.verification_status", "approved")
    .modify((qb) => applyDocumentsGate(qb, "restaurants.documents_valid_until"))
    .groupBy("restaurants.id")
    .havingRaw("COUNT(DISTINCT restaurant_categories.category_id) = ?", [categoryIds.length])
    .select("restaurants.*");

  const itemIds = items.map((i) => i.itemId);

  const candidates = [];
  for (const restaurant of restaurants) {
    const distanceKm = haversineDistanceKm(customerLat, customerLng, Number(restaurant.lat), Number(restaurant.lng));
    if (distanceKm > CASCADE_CEILING_KM) continue; // outside the hard cascade ceiling
    if (!includeClosed && !isOpenNow(restaurant)) continue; // outside its service hours

    const stockRows = await db("restaurant_items")
      .where({ restaurant_id: restaurant.id })
      .whereIn("item_id", itemIds)
      .andWhere({ is_available: true })
      .select("item_id");

    const availableItemIds = new Set(stockRows.map((r) => r.item_id));
    const missingItemIds = itemIds.filter((id) => !availableItemIds.has(id));

    candidates.push({ restaurant, distanceKm, missingItemIds });
  }

  // Fully-stocked candidates first, then by distance — this is the
  // nearest-match-with-cascade-on-unavailability rule in one sort.
  candidates.sort((a, b) => {
    const aFull = a.missingItemIds.length === 0;
    const bFull = b.missingItemIds.length === 0;
    if (aFull !== bFull) return aFull ? -1 : 1;
    return a.distanceKm - b.distanceKm;
  });

  return candidates;
}

/**
 * Picks the best fully-stocked candidate. Returns null if none exists within
 * the cascade ceiling — caller decides what to do next (e.g. for a clubbed
 * cart, fall back to splitting into two single-category searches).
 */
async function findRestaurantForCart({ items, customerLat, customerLng }) {
  const candidates = await findCandidates({ items, customerLat, customerLng });
  const fullMatch = candidates.find((c) => c.missingItemIds.length === 0);
  return {
    match: fullMatch || null,
    cascadeAttempts: candidates.findIndex((c) => c === fullMatch) + 1 || candidates.length,
    allCandidates: candidates,
  };
}

/**
 * Called when no OPEN kitchen can take the cart: is there a fully-stocked kitchen in range that is merely closed right now?
 * Returns { match (the nearest such kitchen, for pricing), opens_at ("HH:MM", earliest next opening among them) } or null.
 */
async function findClosedMatch({ items, customerLat, customerLng }) {
  const candidates = await findCandidates({ items, customerLat, customerLng, includeClosed: true });
  const closed = candidates.filter((c) => c.missingItemIds.length === 0 && !isOpenNow(c.restaurant));
  if (closed.length === 0) return null;
  return { match: closed[0], opens_at: openStatus(closed.map((c) => c.restaurant)).opens_at };
}

/**
 * Computes delivery fee: free within the restaurant's own radius_km, then
 * charged per km beyond that (both admin-configurable).
 */
function computeDeliveryFee(distanceKm, restaurant) {
  const freeRadius = Number(restaurant.radius_km);
  if (distanceKm <= freeRadius) return 0;
  const chargeableKm = distanceKm - freeRadius;
  return Number((chargeableKm * DEFAULT_DELIVERY_RATE_PER_KM).toFixed(2));
}

module.exports = {
  findCandidates,
  findRestaurantForCart,
  findClosedMatch,
  computeDeliveryFee,
  CASCADE_CEILING_KM,
};
