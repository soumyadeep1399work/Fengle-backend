const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { requestOtp, verifyOtp, adminLogin, getSession, logout } = require("../controllers/auth.controller");
const limits = require("../middleware/rateLimit.middleware");

const router = express.Router();

router.post("/otp/request", limits.otpRequest, requestOtp);
router.post("/otp/verify", limits.otpVerify, verifyOtp);
router.post("/admin/login", limits.adminLogin, adminLogin);
router.get("/session", requireAuth(undefined, { allowUnverified: true }), getSession);
router.post("/logout", requireAuth(undefined, { allowUnverified: true }), logout);

module.exports = router;
