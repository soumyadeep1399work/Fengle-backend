const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const restaurantController = require("../controllers/restaurant.controller");

const router = express.Router();

// The logged-in restaurant's own data. Mounted before catalog.routes.js so
// "me" can never be mistaken for a :restaurantId. (The stock toggle,
// PATCH /restaurants/:restaurantId/items/:itemId/availability, lives in
// catalog.routes.js and is a different method/depth, so there's no clash.)
router.get("/me", requireAuth(["restaurant"]), restaurantController.getMyRestaurant);
router.get("/me/menu", requireAuth(["restaurant"]), restaurantController.getMyMenu);
router.get("/me/category-options", requireAuth(["restaurant"]), restaurantController.getCategoryOptions);
router.post("/me/categories", requireAuth(["restaurant"]), restaurantController.addMyCategory);

module.exports = router;
