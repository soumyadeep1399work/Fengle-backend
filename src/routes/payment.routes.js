const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const payments = require("../controllers/payment.controller");

const router = express.Router();

router.use(requireAuth(["customer"]));

router.get("/methods", payments.getPaymentMethods);
router.post("/upi/initiate", payments.initiateUpi);
router.post("/card/charge", payments.chargeCard);

module.exports = router;
