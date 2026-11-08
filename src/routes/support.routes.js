const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const support = require("../controllers/support.controller");

const router = express.Router();
router.use(requireAuth(["customer"]));

router.post("/tickets", support.createTicket);
router.get("/tickets", support.listMyTickets);
router.get("/tickets/:id", support.getMyTicket);

module.exports = router;
