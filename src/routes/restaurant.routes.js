const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const restaurantController = require("../controllers/restaurant.controller");

const router = express.Router();

// All restaurant onboarding/management is admin-only — no self-registration
// endpoint exists anywhere in this router (confirmed business rule).
router.post("/", requireAuth(["admin"]), restaurantController.onboardRestaurant);
router.get("/", requireAuth(["admin"]), restaurantController.listRestaurants);
router.get("/:id", requireAuth(["admin"]), restaurantController.getRestaurantDetail);
router.patch("/:id", requireAuth(["admin"]), restaurantController.updateRestaurant);
router.post("/:id/categories", requireAuth(["admin"]), restaurantController.addRestaurantCategory);
router.delete("/:id/categories/:categoryId", requireAuth(["admin"]), restaurantController.removeRestaurantCategory);

module.exports = router;
