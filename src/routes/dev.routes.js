const express = require("express");
const { getLastDevOtp } = require("../utils/sms");

const router = express.Router();

// Dev-only helper — routes/index.js doesn't mount this router at all when
// NODE_ENV === "production", so it can never leak real OTPs.
router.get("/last-otp", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone query param is required" });

  const entry = getLastDevOtp(phone);
  if (!entry) return res.status(404).json({ error: "No OTP has been requested for this phone since the server started" });
  res.json({ phone, otp: entry.otp, requestedAt: entry.requestedAt });
});

const { advanceOrder, addCredit } = require("../services/devtools.service");

// POST /dev/orders/:id/advance  body/query: { to? } — one step by default;
// to = accepted | picked_up | on_the_way | delivered runs up to that step.
router.post("/orders/:id/advance", async (req, res) => {
  try {
    res.json(await advanceOrder(req.params.id, { to: (req.body && req.body.to) || req.query.to }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /dev/wallet/credit  body: { phone, amount }
router.post("/wallet/credit", async (req, res) => {
  try {
    res.json(await addCredit(req.body && req.body.phone, req.body && req.body.amount));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
