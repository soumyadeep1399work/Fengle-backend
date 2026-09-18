const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const cart = require("../controllers/cart.controller");

const router = express.Router();

router.post("/quote", requireAuth(["customer"]), cart.quoteCart);

module.exports = router;
