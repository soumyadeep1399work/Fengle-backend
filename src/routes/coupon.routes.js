const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const coupons = require("../controllers/coupon.controller");

const router = express.Router();

router.get("/mine", requireAuth(["customer"]), coupons.listMyCoupons);

module.exports = router;
