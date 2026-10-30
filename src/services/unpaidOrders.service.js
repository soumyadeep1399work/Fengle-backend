const db = require("../config/db");

/**
 * Online-payment orders are created BEFORE the payment screen opens (so the cart, prices, fee and coupon are locked in and
 * Razorpay has a receipt to charge against). That leaves an unpaid 'placed' order behind whenever the customer backs out of,
 * fails, or abandons the payment. Kitchens never see those (only paid or COD orders reach them), but they would clutter the
 * admin list and the customer's history, so they are cancelled here:
 *   - immediately, when the app asks (a failed / dismissed payment) — see cancelOrder, which skips the 60 s window for them;
 *   - after PAYMENT_EXPIRY_MINUTES (default 5), by the tick below, for the ones nobody cancelled (app killed, phone off...).
 * A payment that still lands after that is refunded to the customer's Fengle credits (webhook + confirm-payment).
 */

const UNPAID_REASON = "payment_not_completed";
const EXPIRY_MINUTES = Number(process.env.PAYMENT_EXPIRY_MINUTES) || 5;
const TICK_MS = 60 * 1000;
const NO_UPFRONT_PAYMENT = ["cod", "wallet"];

/** An order the customer has not paid for yet, whose payment is a gateway payment (UPI / card / netbanking). */
function isUnpaidOnline(order) {
  return (
    order.status === "placed" &&
    !NO_UPFRONT_PAYMENT.includes(order.payment_method) &&
    ["pending", "failed"].includes(order.payment_status)
  );
}

function unpaidOnlineWhere(qb) {
  return qb.where("status", "placed").whereNotIn("payment_method", NO_UPFRONT_PAYMENT).whereIn("payment_status", ["pending", "failed"]);
}

/** Cancels every unpaid online order older than the expiry. Returns how many were cancelled. */
async function expireUnpaidOrders(now = new Date()) {
  const cutoff = new Date(now.getTime() - EXPIRY_MINUTES * 60 * 1000);
  const ids = (await db("orders").modify(unpaidOnlineWhere).where("created_at", "<", cutoff).select("id")).map((r) => r.id);
  let cancelled = 0;
  for (const id of ids) {
    await db.transaction(async (trx) => {
      // Conditional: a payment that landed since the SELECT wins, and the order is left alone.
      const n = await trx("orders")
        .where({ id })
        .modify(unpaidOnlineWhere)
        .update({ status: "cancelled", cancelled_at: new Date(), cancelled_by: "system", cancel_reason: UNPAID_REASON });
      if (n) {
        await trx("coupon_redemptions").where({ order_id: id }).delete(); // free the coupon up again
        cancelled += 1;
      }
    });
  }
  return cancelled;
}

async function expireUnpaidOrdersSafe() {
  try {
    const n = await expireUnpaidOrders();
    if (n) console.log(`[unpaid-orders] cancelled ${n} unpaid online order(s) older than ${EXPIRY_MINUTES} min`);
  } catch (e) {
    console.error("[unpaid-orders] tick failed:", e.message);
  }
}

let timer = null;
/** Runs once straight away (clears any backlog at boot), then every minute. */
function startTick() {
  if (timer) return;
  expireUnpaidOrdersSafe();
  timer = setInterval(expireUnpaidOrdersSafe, TICK_MS);
  timer.unref();
}

module.exports = { UNPAID_REASON, EXPIRY_MINUTES, isUnpaidOnline, expireUnpaidOrders, expireUnpaidOrdersSafe, startTick };
