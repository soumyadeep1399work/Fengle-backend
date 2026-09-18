const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const restaurantController = require("../controllers/restaurant.controller");

const router = express.Router();

// All restaurant onboarding/management is admin-only — no self-registration
// endpoint exists anywhere in this router (confirmed business rule).
router.post("/", requireAuth(["admin"]), restaurantController.onboardRestaurant);
router.get("/", requireAuth(["admin"]), restaurantController.listRestaurants);
router.patch("/:id", requireAuth(["admin"]), restaurantController.updateRestaurant);
router.post("/:id/categories", requireAuth(["admin"]), restaurantController.addRestaurantCategory);

module.exports = router;
