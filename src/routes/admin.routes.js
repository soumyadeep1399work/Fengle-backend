const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const adminController = require("../controllers/admin.controller");

const router = express.Router();

router.use(requireAuth(["admin"]));

router.get("/dashboard", adminController.dashboardSummary);
router.get("/orders", adminController.listAllOrders);
router.get("/riders", adminController.listRiders);
router.post("/riders/:riderId/settle", adminController.settleRider);

module.exports = router;
