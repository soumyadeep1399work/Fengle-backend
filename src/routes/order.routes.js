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
router.post("/:id/start-preparing", requireAuth(["restaurant"]), orders.startPreparing);

// Rider
router.post("/:id/picked-up", requireAuth(["rider"]), orders.markPickedUp);
router.post("/:id/on-the-way", requireAuth(["rider"]), orders.markOnTheWay);
router.post("/:id/delivered", requireAuth(["rider"]), orders.markDelivered);

// Shared reads
router.get("/", requireAuth(["customer", "restaurant", "rider"]), orders.listMyOrders);
router.get("/:id/status", requireAuth(["customer", "restaurant", "rider", "admin"]), orders.getOrderStatus);
router.get("/:id", requireAuth(["customer", "restaurant", "rider", "admin"]), orders.getOrder);

module.exports = router;
