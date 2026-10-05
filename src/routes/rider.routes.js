const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { parseSelfie } = require("../middleware/selfieUpload.middleware");
const riderController = require("../controllers/rider.controller");

const router = express.Router();

router.get("/me", requireAuth(["rider"], { allowUnverified: true }), riderController.getMyProfile);
router.patch("/me", requireAuth(["rider"], { allowUnverified: true }), riderController.updateMyProfile);
router.get("/me/rate", requireAuth(["rider"]), riderController.getMyRate);
router.patch("/me/availability", requireAuth(["rider"]), riderController.setAvailability);
router.patch("/me/location", requireAuth(["rider"]), riderController.updateLocation);
router.get("/me/orders", requireAuth(["rider"]), riderController.getMyAssignedOrders);
router.post("/me/accept-agreement", requireAuth(["rider"], { allowUnverified: true }), parseSelfie, riderController.acceptRiderAgreement);

module.exports = router;
