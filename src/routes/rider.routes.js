const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const riderController = require("../controllers/rider.controller");

const router = express.Router();

router.patch("/me/availability", requireAuth(["rider"]), riderController.setAvailability);
router.patch("/me/location", requireAuth(["rider"]), riderController.updateLocation);
router.get("/me/orders", requireAuth(["rider"]), riderController.getMyAssignedOrders);

module.exports = router;
