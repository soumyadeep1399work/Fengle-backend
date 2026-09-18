const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const notifications = require("../controllers/notification.controller");

const router = express.Router();

router.use(requireAuth(["customer"]));

router.post("/register-device", notifications.registerDevice);
router.patch("/settings", notifications.updateSettings);

module.exports = router;
