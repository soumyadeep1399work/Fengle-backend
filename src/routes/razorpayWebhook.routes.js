const express = require("express");
const { handleWebhook } = require("../controllers/razorpayWebhook.controller");

const router = express.Router();

// No requireAuth: Razorpay's servers call this, and the handler checks the
// webhook signature itself. Kept out of payment.routes.js because that whole
// router is customer-JWT only.
router.post("/", handleWebhook);

module.exports = router;
