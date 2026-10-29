const db = require("../config/db");
const wallet = require("../services/wallet.service");
const riderPay = require("./riderPay.service");

// LEGACY DEFAULTS — rider pay is now admin-configurable (rider_pay_config, see
// riderPay.service.js). These env values only seed the first config row and keep
// GET /riders/me/rate's old keys alive for older Rider app builds.
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

  // Each order pays what was frozen when it was delivered (admin-set rider pay at that moment);
  // orders delivered before that existed fall back to the current formula.
  const ruleSet = await require("./shippingRules.service").loadRuleSet(db, "rider_pay");
  let totalEarnings = 0;
  let storedCount = 0;
  for (const order of unsettledOrders) {
    const { payout, stored } = await riderPay.settlementPayout({ order, restaurant: restaurantById[order.restaurant_id], ruleSet });
    totalEarnings += payout;
    if (stored) storedCount += 1;
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
        notes: `Settlement for ${unsettledOrders.length} deliveries (${storedCount} at their stored payout, ${unsettledOrders.length - storedCount} at the current rates)`,
      },
      trx
    );

    await trx("orders").whereIn("id", unsettledOrders.map((o) => o.id)).update({ rider_settled_at: new Date() });

    return balanceAfter;
  });

  return { ordersSettled: unsettledOrders.length, totalEarnings, newBalance };
}

module.exports = { settleRider, RIDER_RATE_PER_KM, MIN_EARNING_PER_DELIVERY };
