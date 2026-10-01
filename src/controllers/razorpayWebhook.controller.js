const db = require("../config/db");
const payment = require("../services/payment.service");
const wallet = require("../services/wallet.service");
const { notifyLater } = require("../services/push.service");
const orderPush = require("../services/orderNotifications.service");

const UNPAID = ["pending", "failed"];

/**
 * Records a payment Razorpay says it captured. Safe to call any number of
 * times for the same order (Razorpay retries and can deliver an event twice,
 * and the app's own confirm-payment may land first): every write is
 * conditional on the order still being unpaid, so only the call that actually
 * makes the transition has any effect.
 */
async function recordCapturedPayment(razorpayOrderId, razorpayPaymentId) {
  const order = await db("orders").where({ razorpay_order_id: razorpayOrderId }).first();
  if (!order) return "unknown_order";
  if (!UNPAID.includes(order.payment_status)) return "already_settled";

  if (order.status === "cancelled") {
    // The money arrived after the order was cancelled (e.g. the customer paid
    // in their UPI app but the app had already given up on the checkout and
    // cancelled). Nothing will be delivered, so it goes back to them the same
    // way every other refund here does — as wallet credit.
    return db.transaction(async (trx) => {
      const changed = await trx("orders")
        .where({ id: order.id })
        .whereIn("payment_status", UNPAID)
        .update({ payment_status: "refunded", razorpay_payment_id: razorpayPaymentId });
      if (!changed) return "already_settled";
      await wallet.recordCustomerRefund(
        order.customer_id,
        order.id,
        Number(order.grand_total),
        "Payment received after the order was cancelled",
        trx
      );
      return "refunded_cancelled_order";
    });
  }

  const changed = await db("orders")
    .where({ id: order.id })
    .whereIn("payment_status", UNPAID)
    .update({ payment_status: "paid", razorpay_payment_id: razorpayPaymentId });
  if (!changed) return "already_settled";

  // Paid now, so the kitchen can see it — same as confirmPayment.
  if (order.status === "placed") notifyLater(() => orderPush.newOrderForRestaurant(order.id));
  return "marked_paid";
}

/**
 * POST /payments/razorpay/webhook
 * Called by Razorpay's servers, not the app — no JWT; the request is trusted
 * only if its signature matches (see verifyWebhookSignature). This is the
 * safety net for a payment that succeeds but whose confirm-payment call never
 * arrives (app closed, network dropped, UPI app never returned to Fengle).
 *
 * Replies 200 for every correctly-signed event, including ones it ignores,
 * so Razorpay stops retrying; 5xx only when recording a capture actually
 * failed and a retry could help.
 */
async function handleWebhook(req, res) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Razorpay webhook is not configured" });
  }
  if (!payment.verifyWebhookSignature(req.rawBody, req.get("x-razorpay-signature"))) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const event = req.body && req.body.event;
  const entity = req.body && req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;

  // payment.captured is the one that means "the money is ours". payment.failed
  // is deliberately ignored: the customer can retry on the same Razorpay order.
  if (event !== "payment.captured" || !entity || !entity.order_id) {
    return res.json({ received: true, handled: false });
  }

  try {
    const result = await recordCapturedPayment(entity.order_id, entity.id);
    console.log(`[razorpay-webhook] ${event} ${entity.id} for ${entity.order_id}: ${result}`);
    return res.json({ received: true, handled: true, result });
  } catch (err) {
    console.error(`[razorpay-webhook] failed to record ${entity.id} for ${entity.order_id}:`, err);
    return res.status(500).json({ error: "Could not record the payment" });
  }
}

module.exports = { handleWebhook };
