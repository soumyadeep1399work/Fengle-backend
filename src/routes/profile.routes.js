const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const profile = require("../controllers/profile.controller");
const limits = require("../middleware/rateLimit.middleware");

const router = express.Router();

router.use(requireAuth(["customer"]));

router.get("/me", profile.getMyProfile);
router.patch("/me", profile.updateMyProfile);
router.post("/phone/request-change", limits.otpRequest, profile.requestPhoneChange); // OTP to the NEW number
router.post("/phone/verify-change", limits.otpVerify, profile.verifyPhoneChange);
router.patch("/preferences", profile.updatePreferences);
router.patch("/default-address", profile.setDefaultAddress);
router.post("/accept-agreement", profile.acceptAgreement);

module.exports = router;
