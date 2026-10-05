const express = require("express");

const router = express.Router();

// Dev/test tools — this whole router is NOT mounted when NODE_ENV=production
// (see routes/index.js). Never move any of these into an always-mounted router:
// last-otp in particular lets anyone log in as any phone number.
const { advanceOrder, addCredit } = require("../services/devtools.service");
const { getLastDevOtp } = require("../utils/sms");

// GET /dev/last-otp?phone=<10 digits> — the last OTP requested for that phone
// since the server started (only populated when no SMS provider is configured).
router.get("/last-otp", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone query param is required" });
  const entry = getLastDevOtp(phone);
  if (!entry) return res.status(404).json({ error: "No OTP has been requested for this phone since the server started" });
  res.json({ phone, otp: entry.otp, requestedAt: entry.requestedAt });
});

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
