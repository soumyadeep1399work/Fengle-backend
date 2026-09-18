// In dev (or whenever RAZORPAY_KEY_ID is unset), payments auto-succeed so the
// order flow can be built and tested end-to-end without waiting on Razorpay
// Route eligibility approval — swap to real credentials in .env when ready,
// no code changes needed.

const isConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

let razorpayClient = null;
function getClient() {
  if (!isConfigured()) return null;
  if (!razorpayClient) {
    // Lazy-required so the `razorpay` package is only needed once real keys exist.
    const Razorpay = require("razorpay");
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

/**
 * Creates a payment order. Amount in rupees (converted to paise internally
 * for the real Razorpay API).
 */
async function createPaymentOrder(amountRupees, receiptId) {
  const client = getClient();

  if (!client) {
    // Dev stub — looks like a Razorpay order object, good enough for the
    // frontend to build against, and clearly marked so nobody mistakes it
    // for a real transaction.
    return {
      id: `dev_order_${receiptId}_${Date.now()}`,
      amount: Math.round(amountRupees * 100),
      currency: "INR",
      status: "created",
      dev_stub: true,
    };
  }

  return client.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: "INR",
    receipt: String(receiptId),
  });
}

/**
 * Verifies a payment signature. Always "verified" in dev-stub mode.
 */
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!isConfigured()) {
    return true;
  }
  const crypto = require("crypto");
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  return expected === razorpaySignature;
}

module.exports = { createPaymentOrder, verifyPaymentSignature, isConfigured };
