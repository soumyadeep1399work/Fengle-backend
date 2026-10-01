const express = require("express");

const router = express.Router();

// last-otp lives in its own always-mounted router (otpLookup.routes.js) now —
// see that file for why. The two routes below are still real dev/test tools
// (force-advance any order, mint free wallet credit) and stay unmounted in
// production, same as always.
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
