const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const profile = require("../controllers/profile.controller");

const router = express.Router();

router.use(requireAuth(["customer"]));

router.get("/me", profile.getMyProfile);
router.patch("/me", profile.updateMyProfile);
router.patch("/preferences", profile.updatePreferences);
router.patch("/default-address", profile.setDefaultAddress);
router.post("/accept-agreement", profile.acceptAgreement);

module.exports = router;
