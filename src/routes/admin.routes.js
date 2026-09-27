const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const adminController = require("../controllers/admin.controller");
const adminOrders = require("../controllers/adminOrders.controller");
const adminCustomers = require("../controllers/adminCustomers.controller");
const adminCategories = require("../controllers/adminCategories.controller");

const router = express.Router();

router.use(requireAuth(["admin"]));

router.get("/dashboard", adminController.dashboardSummary);

// Orders
router.get("/orders", adminOrders.listOrders);
router.get("/orders/:id", adminOrders.getOrder);
router.post("/orders/:id/cancel", adminOrders.cancelOrder);
router.post("/orders/:id/reassign-rider", adminOrders.reassignRider);

// Riders
router.get("/riders", adminController.listRiders);
router.get("/riders/:id", adminController.getRider);
router.patch("/riders/:id", adminController.updateRiderStatus);
router.post("/riders/:riderId/settle", adminController.settleRider);
router.get("/settlements", adminController.listSettlements);

// Categories & items
router.get("/categories", adminCategories.listCategories);
router.patch("/categories/:id", adminCategories.updateCategory);
router.post("/categories/:id/merge", adminCategories.mergeCategories);
router.get("/items", adminCategories.listItems);

// Customers
router.get("/customers/export.csv", adminCustomers.exportCustomersCsv); // before /:id — "export.csv" would otherwise look like an :id
router.get("/customers", adminCustomers.listCustomers);
router.get("/customers/:id", adminCustomers.getCustomer);
router.patch("/customers/:id", adminCustomers.updateCustomerStatus);
router.post("/customers/:id/wallet-credit", adminCustomers.creditCustomerWallet);

module.exports = router;
