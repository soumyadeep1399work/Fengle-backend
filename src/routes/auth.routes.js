const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { requestOtp, verifyOtp, adminLogin, getSession, logout } = require("../controllers/auth.controller");

const router = express.Router();

router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);
router.post("/admin/login", adminLogin);
router.get("/session", requireAuth(), getSession);
router.post("/logout", requireAuth(), logout);

module.exports = router;
