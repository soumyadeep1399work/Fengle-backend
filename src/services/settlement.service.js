const db = require("../config/db");
const wallet = require("../services/wallet.service");
const { haversineDistanceKm } = require("../utils/geo");

// PLACEHOLDER RATE — this was never pinned down in the confirmed business
// rules (CLAUDE.md covers the COD/wallet *mechanism*, not the exact rider
// earning formula). Treat this as a starting default to confirm with the
// client, not a settled figure. Configurable via env so it can change
// without a code deploy.
const RIDER_RATE_PER_KM = Number(process.env.RIDER_RATE_PER_KM) || 8;
const MIN_EARNING_PER_DELIVERY = Number(process.env.RIDER_MIN_EARNING_PER_DELIVERY) || 15;

/**
 * Settles ONE rider for all their delivered-but-unsettled orders. COD amounts
 * were already debited at the moment of delivery (wallet.recordCodCollection);
 * this credits the period's total earnings in one entry, which nets out
 * against whatever COD liability has accumulated — the resulting balance
 * tells you whether the rider is owed a payout or owes the platform.
 *
 * Not scheduled automatically (no cron in this codebase yet) — call this from
 * an admin-triggered endpoint or wire up a scheduled job later.
 */
async function settleRider(riderId) {
  const unsettledOrders = await db("orders")
    .where({ rider_id: riderId, status: "delivered" })
    .whereNull("rider_settled_at");

  if (unsettledOrders.length === 0) {
    return { ordersSettled: 0, totalEarnings: 0, newBalance: await wallet.getBalance("rider", riderId) };
  }

  const restaurantIds = [...new Set(unsettledOrders.map((o) => o.restaurant_id))];
  const restaurants = await db("restaurants").whereIn("id", restaurantIds);
  const restaurantById = Object.fromEntries(restaurants.map((r) => [r.id, r]));

  let totalEarnings = 0;
  for (const order of unsettledOrders) {
    const restaurant = restaurantById[order.restaurant_id];
    const distanceKm = haversineDistanceKm(
      Number(restaurant.lat), Number(restaurant.lng),
      Number(order.delivery_lat), Number(order.delivery_lng)
    );
    const earning = Math.max(MIN_EARNING_PER_DELIVERY, Number((distanceKm * RIDER_RATE_PER_KM).toFixed(2)));
    totalEarnings += earning;
  }
  totalEarnings = Number(totalEarnings.toFixed(2));

  const newBalance = await db.transaction(async (trx) => {
    const balanceAfter = await wallet.recordEntry(
      {
        ownerType: "rider",
        ownerId: riderId,
        entryType: "credit",
        amount: totalEarnings,
        reason: "settlement_payout",
        notes: `Settlement for ${unsettledOrders.length} deliveries at ₹${RIDER_RATE_PER_KM}/km (min ₹${MIN_EARNING_PER_DELIVERY}/delivery)`,
      },
      trx
    );

    await trx("orders").whereIn("id", unsettledOrders.map((o) => o.id)).update({ rider_settled_at: new Date() });

    return balanceAfter;
  });

  return { ordersSettled: unsettledOrders.length, totalEarnings, newBalance };
}

module.exports = { settleRider, RIDER_RATE_PER_KM, MIN_EARNING_PER_DELIVERY };
