const db = require("../config/db");
const routing = require("../services/routing.service");
const { computeTax } = require("../services/tax.service");
const couponService = require("../services/coupon.service");

const MIN_ORDER_VALUE = 50; // keep in sync with order.controller.js

/**
 * POST /cart/quote
 * body: { items: [{item_id, quantity}], delivery_lat, delivery_lng }
 *
 * Server-computed pricing preview AND the club/lock check for the Lock/Club
 * kitchen bottom sheets — the frontend calls this whenever the proposed cart
 * changes (including "what if I add this item from another category")
 * rather than replicating the routing engine's radius/cascade logic itself.
 * Never persists anything and never reveals restaurant identity/name to the
 * customer — only whether a single kitchen can serve the whole cart.
 */
async function quoteCart(req, res) {
  const { items, delivery_lat, delivery_lng, coupon_code } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array is required" });
  }
  if (delivery_lat == null || delivery_lng == null) {
    return res.status(400).json({ error: "delivery_lat and delivery_lng are required" });
  }

  const itemIds = items.map((i) => i.item_id);
  const itemRows = await db("items").whereIn("id", itemIds).andWhere({ is_active: true });
  if (itemRows.length !== itemIds.length) {
    return res.status(400).json({ error: "One or more items are invalid or inactive" });
  }
  const itemById = Object.fromEntries(itemRows.map((r) => [r.id, r]));

  const cartItems = items.map((i) => ({
    itemId: i.item_id,
    categoryId: itemById[i.item_id].category_id,
    quantity: i.quantity,
    unitPrice: Number(itemById[i.item_id].price),
  }));

  const categoryIds = [...new Set(cartItems.map((i) => i.categoryId))];
  if (categoryIds.length > 2) {
    return res.status(400).json({ error: "An order can include at most 2 categories (clubbed orders only)" });
  }

  const itemTotal = Number(cartItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0).toFixed(2));
  const minOrderOk = itemTotal >= MIN_ORDER_VALUE;

  const { match } = await routing.findRestaurantForCart({
    items: cartItems.map((i) => ({ itemId: i.itemId, categoryId: i.categoryId })),
    customerLat: Number(delivery_lat),
    customerLng: Number(delivery_lng),
  });

  const clubbable = Boolean(match);

  if (!clubbable) {
    // Either a single-category cart with nobody in range, or a 2-category
    // cart that no single kitchen can fulfil together — either way there's
    // no one grand_total to quote yet. The frontend shows the Lock sheet
    // for the 2-category case, or a "nothing nearby" state for the other.
    return res.json({
      valid: false,
      minOrderOk,
      categoryIds,
      clubbable: false,
      itemTotal,
      reason: categoryIds.length === 2
        ? "No single kitchen nearby can prepare both categories together"
        : "No kitchen nearby currently serves this category",
    });
  }

  const deliveryFee = routing.computeDeliveryFee(match.distanceKm, match.restaurant);
  const { cgstAmount, sgstAmount } = computeTax(itemTotal);

  // Preview only — nothing persisted, no redemption row, no trx/lock. The
  // real, race-safe check happens again inside POST /orders at placement.
  let couponDiscount = 0;
  let couponError = null;
  if (coupon_code) {
    const result = await couponService.validateCoupon({ code: coupon_code, customerId: req.auth.id, itemTotal });
    if (result.error) couponError = result.error;
    else couponDiscount = result.discount;
  }

  const grandTotal = Number((itemTotal + deliveryFee + cgstAmount + sgstAmount - couponDiscount).toFixed(2));

  res.json({
    valid: minOrderOk,
    minOrderOk,
    categoryIds,
    clubbable: true,
    isClubbed: categoryIds.length === 2,
    itemTotal,
    deliveryFee,
    cgstAmount,
    sgstAmount,
    couponDiscount,
    couponError,
    grandTotal,
    reason: minOrderOk ? null : `Minimum order value is ₹${MIN_ORDER_VALUE}`,
  });
}

module.exports = { quoteCart };
