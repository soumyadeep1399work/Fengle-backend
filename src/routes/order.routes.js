const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const orders = require("../controllers/order.controller");

const router = express.Router();

// Customer
router.post("/", requireAuth(["customer"]), orders.placeOrder);
router.post("/:id/confirm-payment", requireAuth(["customer"]), orders.confirmPayment);
router.post("/:id/cancel", requireAuth(["customer"]), orders.cancelOrder);
router.post("/:id/rate-rider", requireAuth(["customer"]), orders.rateRider);
router.post("/:id/rate-restaurant", requireAuth(["customer"]), orders.rateRestaurant);
router.post("/:id/skip-restaurant-rating", requireAuth(["customer"]), orders.skipRestaurantRating);
router.get("/:id/rider", requireAuth(["customer"]), orders.getOrderRider);
router.get("/:id/invoice", requireAuth(["customer"]), orders.getOrderInvoice);
router.get("/:id/invoice/pdf", requireAuth(["customer"]), orders.getOrderInvoicePdf);
router.post("/:id/reorder", requireAuth(["customer"]), orders.reorder);

// Restaurant
router.post("/:id/accept", requireAuth(["restaurant"]), orders.acceptOrder);
router.post("/:id/reject", requireAuth(["restaurant"]), orders.rejectOrder);
router.post("/:id/acknowledge", requireAuth(["restaurant"]), orders.acknowledgeOrder); // Stop alarm: seen, not yet decided
router.post("/:id/start-preparing", requireAuth(["restaurant"]), orders.startPreparing);
router.post("/:id/mark-ready", requireAuth(["restaurant"]), orders.markReady);

// Rider
router.post("/:id/rider-acknowledge", requireAuth(["rider"]), orders.acknowledgeAsRider); // "View assignment" on the new-delivery alert
router.post("/:id/reached-restaurant", requireAuth(["rider"]), orders.reachedRestaurant); // arrival buttons (GPS + time, manual allowed, never blocked)
router.post("/:id/reached-customer", requireAuth(["rider"]), orders.reachedCustomer);
router.post("/:id/picked-up", requireAuth(["rider"]), orders.markPickedUp);
router.post("/:id/on-the-way", requireAuth(["rider"]), orders.markOnTheWay);
router.post("/:id/delivered", requireAuth(["rider"]), orders.markDelivered);

// Shared reads
router.get("/", requireAuth(["customer", "restaurant", "rider"]), orders.listMyOrders);
router.get("/:id/status", requireAuth(["customer", "restaurant", "rider", "admin"]), orders.getOrderStatus);
router.get("/:id", requireAuth(["customer", "restaurant", "rider", "admin"]), orders.getOrder);

module.exports = router;
