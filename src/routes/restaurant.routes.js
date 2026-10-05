const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth.middleware");
const restaurantController = require("../controllers/restaurant.controller");

const router = express.Router();

// All restaurant onboarding/management is admin-only — no self-registration
// endpoint exists anywhere in this router (confirmed business rule).
// Reads: every admin role. Writes: super_admin + ops (support is read-only).
const staff = requireRole("super_admin", "ops");

router.post("/", requireAuth(["admin"]), staff, restaurantController.onboardRestaurant);
router.get("/", requireAuth(["admin"]), restaurantController.listRestaurants);
router.get("/:id", requireAuth(["admin"]), restaurantController.getRestaurantDetail);
router.patch("/:id", requireAuth(["admin"]), staff, restaurantController.updateRestaurant);
router.post("/:id/categories", requireAuth(["admin"]), staff, restaurantController.addRestaurantCategory);
router.delete("/:id/categories/:categoryId", requireAuth(["admin"]), staff, restaurantController.removeRestaurantCategory);
router.get("/:id/agreement-selfie", requireAuth(["admin"]), restaurantController.getRestaurantAgreementSelfie);
router.post("/:id/verification", requireAuth(["admin"]), staff, restaurantController.reviewRestaurantVerification);

module.exports = router;
