const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const notifications = require("../controllers/notification.controller");

const router = express.Router();

// Every app registers its device for push; only customers have on/off settings.
router.post("/register-device", requireAuth(["customer", "restaurant", "rider"], { allowUnverified: true }), notifications.registerDevice);
router.patch("/settings", requireAuth(["customer"]), notifications.updateSettings);

module.exports = router;
