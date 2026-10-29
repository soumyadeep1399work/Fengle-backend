const db = require("../config/db");

const money = (n) => Number(Number(n).toFixed(2));

/**
 * Vendor cost of each dish for a given kitchen. TODAY it is one cost per dish, the same for every
 * kitchen (items.vendor_cost). This is the single seam for a per-kitchen override: add a
 * restaurant_item_costs table and prefer its row here — every caller (order placement, the
 * payable recompute) already passes the kitchen id.
 * @returns {Promise<Map<number, number|null>>} itemId -> unit cost, or null when the dish has none yet
 */
async function getVendorCosts(conn, itemIds, restaurantId) { // eslint-disable-line no-unused-vars
  const ids = [...new Set(itemIds)];
  if (!ids.length) return new Map();
  const rows = await conn("items").whereIn("id", ids).select("id", "vendor_cost");
  return new Map(rows.map((r) => [r.id, r.vendor_cost == null ? null : Number(r.vendor_cost)]));
}

/**
 * What Fengle owes the kitchen for an order, from its confirmed lines:
 *   a line with a vendor cost  -> vendor_cost x quantity
 *   a line without one         -> the old formula: line subtotal minus the kitchen's commission % (and the order
 *                                 is flagged `estimated`, so admins can see which dishes still need a cost)
 * Coupons and dish offers never reduce it: Fengle bears all discounts.
 * @param {Array<{quantity:number, subtotal:number|string, vendor_cost:number|string|null}>} lines confirmed lines only
 * @param {{commission_rate_percent:number|string}} restaurant
 */
function computePayable(lines, restaurant) {
  const rate = Number(restaurant.commission_rate_percent || 0);
  let payable = 0;
  let estimated = false;
  for (const l of lines) {
    if (l.vendor_cost != null) {
      payable += Number(l.vendor_cost) * Number(l.quantity);
    } else {
      estimated = true;
      payable += Number(l.subtotal) - (Number(l.subtotal) * rate) / 100;
    }
  }
  return { payable: money(payable), estimated };
}

/** Recomputes orders.restaurant_payable / payable_estimated from the order's confirmed lines. Call wherever the confirmed lines or the kitchen change. */
async function recomputeForOrder(conn, orderId) {
  const order = await conn("orders").where({ id: orderId }).select("id", "restaurant_id").first();
  if (!order || !order.restaurant_id) return null;
  const restaurant = await conn("restaurants").where({ id: order.restaurant_id }).select("commission_rate_percent").first();
  const lines = await conn("order_items").where({ order_id: orderId, status: "confirmed" }).select("quantity", "subtotal", "vendor_cost");
  const { payable, estimated } = computePayable(lines, restaurant);
  await conn("orders").where({ id: orderId }).update({ restaurant_payable: payable, payable_estimated: estimated });
  return { payable, estimated };
}

module.exports = { getVendorCosts, computePayable, recomputeForOrder };
