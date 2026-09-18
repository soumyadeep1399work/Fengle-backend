const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const addresses = require("../controllers/address.controller");

const router = express.Router();

router.use(requireAuth(["customer"]));

router.get("/", addresses.listMyAddresses);
router.post("/", addresses.createAddress);
router.patch("/:id", addresses.updateAddress);
router.delete("/:id", addresses.deleteAddress);

module.exports = router;
