const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { parseSelfie } = require("../middleware/selfieUpload.middleware");
const { parseSupportAttachments } = require("../middleware/supportUpload.middleware");
const restaurantController = require("../controllers/restaurant.controller");
const kitchenEarnings = require("../controllers/kitchenEarnings.controller");
const kitchenSupport = require("../controllers/partnerSupport.controller").forPartner("restaurant");

const router = express.Router();

// The logged-in restaurant's own data. Mounted before catalog.routes.js so
// "me" can never be mistaken for a :restaurantId. (The stock toggle,
// PATCH /restaurants/:restaurantId/items/:itemId/availability, lives in
// catalog.routes.js and is a different method/depth, so there's no clash.)
router.get("/me", requireAuth(["restaurant"], { allowUnverified: true }), restaurantController.getMyRestaurant);
router.patch("/me/availability", requireAuth(["restaurant"]), restaurantController.setMyAvailability); // behind the verification gate
// Partner support (tickets with a reply thread + screenshots). allowUnverified: a kitchen under review or denied can still ask for help.
const supportAuth = requireAuth(["restaurant"], { allowUnverified: true });
router.post("/me/support-tickets", supportAuth, parseSupportAttachments, kitchenSupport.createTicket);
router.get("/me/support-tickets", supportAuth, kitchenSupport.listTickets);
router.get("/me/support-tickets/:id", supportAuth, kitchenSupport.getTicket);
router.post("/me/support-tickets/:id/messages", supportAuth, parseSupportAttachments, kitchenSupport.addMessage);
router.get("/me/support-tickets/:id/attachments/:attachmentId", supportAuth, kitchenSupport.getAttachment);
// Sales & Earnings (day-level aggregates of the kitchen's own data) and signed download links. Behind the verification gate.
router.get("/me/sales", requireAuth(["restaurant"]), kitchenEarnings.sales);
router.get("/me/payouts", requireAuth(["restaurant"]), kitchenEarnings.payouts);
router.post("/me/downloads", requireAuth(["restaurant"]), kitchenEarnings.createDownload);
router.put("/me/bank-account", requireAuth(["restaurant"]), restaurantController.putMyBankAccount);
router.get("/me/menu", requireAuth(["restaurant"]), restaurantController.getMyMenu);
router.get("/me/category-options", requireAuth(["restaurant"]), restaurantController.getCategoryOptions);
router.post("/me/categories", requireAuth(["restaurant"]), restaurantController.addMyCategory);
router.post("/me/accept-agreement", requireAuth(["restaurant"], { allowUnverified: true }), parseSelfie, restaurantController.acceptRestaurantAgreement);

module.exports = router;
