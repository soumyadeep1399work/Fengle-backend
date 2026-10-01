const express = require("express");
const { getLastDevOtp } = require("../utils/sms");

const router = express.Router();

// TEMPORARY, user-approved exception (2026-10-01): mounted in EVERY
// environment, including production, unlike the rest of dev.routes.js —
// the user explicitly asked to get this back during pre-launch testing
// (no real SMS provider is configured yet, so this is the only way to see
// an OTP) after being told plainly what it exposes: NO AUTH, anyone who
// knows a phone number used this platform can fetch its last OTP and log
// into that account. Accepted as a known, temporary, informed risk — MUST
// be removed (or gated behind admin auth) before real users are onboarded.
// See CLAUDE.md's "Known temporary exceptions" and the AWS deployment
// memory note for the full history (this is the second time this exact
// exposure has existed on production).
router.get("/last-otp", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone query param is required" });

  const entry = getLastDevOtp(phone);
  if (!entry) return res.status(404).json({ error: "No OTP has been requested for this phone since the server started" });
  res.json({ phone, otp: entry.otp, requestedAt: entry.requestedAt });
});

module.exports = router;
