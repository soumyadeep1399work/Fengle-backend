const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const catalog = require("../controllers/catalog.controller");

const router = express.Router();

router.get("/categories", catalog.listCategories);
router.post("/categories", requireAuth(["admin"]), catalog.createCategory);

router.get("/categories/:id", catalog.getCategoryDetail);
router.get("/categories/:categoryId/items", catalog.listItemsForCategory);
router.get("/items/search", catalog.searchItems);
router.get("/items/popular", catalog.getPopularItems);
router.post("/items", requireAuth(["admin", "restaurant"]), catalog.createItem);
router.patch("/items/:id", requireAuth(["admin", "restaurant"]), catalog.updateItem);

router.patch(
  "/restaurants/:restaurantId/items/:itemId/availability",
  requireAuth(["restaurant"]),
  catalog.setItemAvailability
);

module.exports = router;
