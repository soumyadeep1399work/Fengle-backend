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

  const order = await client.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: "INR",
    receipt: String(receiptId),
  });
  return { ...order, dev_stub: false };
}

/** The public key_id — safe to send to the client (unlike the secret). null when not configured. */
function getPublicKeyId() {
  return isConfigured() ? process.env.RAZORPAY_KEY_ID : null;
}

/**
 * Verifies a payment signature. Always "verified" in dev-stub mode.
 */
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!isConfigured()) {
    return true;
  }
  if (typeof razorpaySignature !== "string") return false;
  const crypto = require("crypto");
  const expected = Buffer.from(
    crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex")
  );
  const given = Buffer.from(razorpaySignature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Verifies a Razorpay webhook: X-Razorpay-Signature must be the HMAC-SHA256 of
 * the exact raw request body, keyed with the webhook's own secret (set when
 * the webhook is created in the Razorpay dashboard — not the API key secret).
 * False when no webhook secret is configured.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || typeof signature !== "string") return false;
  const crypto = require("crypto");
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { createPaymentOrder, verifyPaymentSignature, verifyWebhookSignature, isConfigured, getPublicKeyId };
