const db = require("../config/db");
const payment = require("../services/payment.service");
const wallet = require("../services/wallet.service");
const { notifyLater } = require("../services/push.service");
const orderPush = require("../services/orderNotifications.service");

/**
 * GET /payments/methods
 * Static list for now — no saved-card/UPI-handle storage exists yet (flagged
 * gap), so this can't yet return "Visa •••• 4412"-style saved instruments,
 * just which payment types are currently offered plus the wallet balance so
 * the checkout screen can show "₹214.00 available" without a second call.
 */
async function getPaymentMethods(req, res) {
  const balance = await wallet.getBalance("customer", req.auth.id);
  res.json({
    methods: [
      { id: "upi", label: "UPI", enabled: true },
      { id: "card", label: "Card", enabled: true },
      { id: "cod", label: "Cash on Delivery", enabled: true },
      { id: "wallet", label: "Platter Credits", enabled: true, balance },
    ],
  });
}

async function loadOwnPendingOrder(req, res) {
  const { order_id } = req.body;
  if (!order_id) {
    res.status(400).json({ error: "order_id is required" });
    return null;
  }
  const order = await db("orders").where({ id: order_id }).first();
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return null;
  }
  if (Number(order.customer_id) !== Number(req.auth.id)) {
    res.status(403).json({ error: "Not your order" });
    return null;
  }
  if (order.payment_status === "paid") {
    res.status(409).json({ error: "This order is already paid" });
    return null;
  }
  return order;
}

/**
 * POST /payments/upi/initiate
 * body: { order_id }
 * Idempotent: an order placed with payment_method 'upi' already gets a
 * Razorpay order created inline by placeOrder, so this mostly matters for
 * resuming payment on an order that was placed before the app was ready to
 * open the UPI/checkout flow (e.g. after an app restart) — it returns the
 * existing razorpay_order_id rather than minting a second one.
 */
async function initiateUpi(req, res) {
  const order = await loadOwnPendingOrder(req, res);
  if (!order) return;
  if (order.payment_method !== "upi") {
    return res.status(400).json({ error: `This order's payment method is '${order.payment_method}', not upi` });
  }

  if (order.razorpay_order_id) {
    return res.json({ payment: { id: order.razorpay_order_id, amount: Math.round(Number(order.grand_total) * 100), currency: "INR", status: "created" } });
  }

  const paymentOrder = await payment.createPaymentOrder(order.grand_total, order.id);
  await db("orders").where({ id: order.id }).update({ razorpay_order_id: paymentOrder.id });
  res.json({ payment: paymentOrder });
}

/**
 * POST /payments/card/charge
 * body: { order_id }
 * Dev-stub mode (no Razorpay keys set) auto-succeeds the charge immediately,
 * consistent with every other payment path in this codebase. Real
 * server-side card charging (tokenized card + Razorpay's charge API) isn't
 * implemented — once real keys are configured, use the standard Razorpay
 * Checkout + POST /orders/:id/confirm-payment flow instead of this endpoint.
 */
async function chargeCard(req, res) {
  const order = await loadOwnPendingOrder(req, res);
  if (!order) return;
  if (order.payment_method !== "card") {
    return res.status(400).json({ error: `This order's payment method is '${order.payment_method}', not card` });
  }

  if (payment.isConfigured()) {
    return res.status(501).json({
      error: "Direct server-side card charging isn't implemented against live Razorpay yet — use Razorpay Checkout and POST /orders/:id/confirm-payment instead.",
    });
  }

  await db("orders").where({ id: order.id }).update({ payment_status: "paid" });
  const updated = await db("orders").where({ id: order.id }).first();
  if (updated.status === "placed") notifyLater(() => orderPush.newOrderForRestaurant(order.id)); // now visible to the kitchen
  res.json({ order: updated, payment: { status: "captured", dev_stub: true } });
}

module.exports = { getPaymentMethods, initiateUpi, chargeCard };
