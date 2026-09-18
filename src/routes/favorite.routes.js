const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const favorites = require("../controllers/favorite.controller");

const router = express.Router();

router.use(requireAuth(["customer"]));

router.get("/", favorites.listFavorites);
router.post("/:itemId", favorites.addFavorite);
router.delete("/:itemId", favorites.removeFavorite);

module.exports = router;
