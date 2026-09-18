const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const walletController = require("../controllers/wallet.controller");

const router = express.Router();

router.get("/me", requireAuth(["customer", "rider"]), walletController.getMyWallet);
router.get("/balance", requireAuth(["customer", "rider"]), walletController.getMyBalance);
router.get("/ledger", requireAuth(["customer", "rider"]), walletController.getMyLedger);

module.exports = router;
