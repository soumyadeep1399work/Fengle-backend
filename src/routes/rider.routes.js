const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { parseSelfie } = require("../middleware/selfieUpload.middleware");
const { parseSupportAttachments } = require("../middleware/supportUpload.middleware");
const riderController = require("../controllers/rider.controller");
const riderSupport = require("../controllers/partnerSupport.controller").forPartner("rider");

const router = express.Router();

router.get("/me", requireAuth(["rider"], { allowUnverified: true }), riderController.getMyProfile);
router.patch("/me", requireAuth(["rider"], { allowUnverified: true }), riderController.updateMyProfile);
router.put("/me/bank-account", requireAuth(["rider"]), riderController.putBankAccount); // behind the verification gate: payouts only go to approved riders
router.get("/me/rate", requireAuth(["rider"]), riderController.getMyRate);
router.patch("/me/availability", requireAuth(["rider"]), riderController.setAvailability);
router.patch("/me/location", requireAuth(["rider"]), riderController.updateLocation);
router.get("/me/orders", requireAuth(["rider"]), riderController.getMyAssignedOrders);
router.post("/me/accept-agreement", requireAuth(["rider"], { allowUnverified: true }), parseSelfie, riderController.acceptRiderAgreement);

// Partner support (tickets with a reply thread + screenshots): the same implementation as the kitchens'. allowUnverified: a rider whose
// selfie is still under review, or was denied, can still ask for help.
const supportAuth = requireAuth(["rider"], { allowUnverified: true });
router.post("/me/support-tickets", supportAuth, parseSupportAttachments, riderSupport.createTicket);
router.get("/me/support-tickets", supportAuth, riderSupport.listTickets);
router.get("/me/support-tickets/:id", supportAuth, riderSupport.getTicket);
router.post("/me/support-tickets/:id/messages", supportAuth, parseSupportAttachments, riderSupport.addMessage);
router.get("/me/support-tickets/:id/attachments/:attachmentId", supportAuth, riderSupport.getAttachment);

module.exports = router;
