const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth.middleware");
const catalog = require("../controllers/catalog.controller");

const router = express.Router();

router.get("/categories", catalog.listCategories);
// Admin-typed catalog writes need super_admin or ops (support is read-only); restaurant tokens are unaffected.
const staff = requireRole("super_admin", "ops");

router.post("/categories", requireAuth(["admin"]), staff, catalog.createCategory);

router.get("/categories/:id", catalog.getCategoryDetail);
router.get("/categories/:categoryId/items", catalog.listItemsForCategory);
router.get("/items/search", catalog.searchItems);
router.get("/items/popular", catalog.getPopularItems);
router.post("/items", requireAuth(["admin", "restaurant"]), staff, catalog.createItem);
router.patch("/items/:id", requireAuth(["admin", "restaurant"]), staff, catalog.updateItem);

router.patch(
  "/restaurants/:restaurantId/items/:itemId/availability",
  requireAuth(["restaurant"]),
  catalog.setItemAvailability
);

module.exports = router;
