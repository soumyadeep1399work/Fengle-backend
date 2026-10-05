const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth.middleware");
const adminController = require("../controllers/admin.controller");
const adminOrders = require("../controllers/adminOrders.controller");
const adminCustomers = require("../controllers/adminCustomers.controller");
const adminCategories = require("../controllers/adminCategories.controller");
const adminCoupons = require("../controllers/adminCoupons.controller");
const adminAdmins = require("../controllers/adminAdmins.controller");

const router = express.Router();

router.use(requireAuth(["admin"]));

// Role matrix (Admin Panel RBAC, 2026-10-05). Every admin GET is open to all roles except
// customers/export.csv and /admin/admins. Writes:
//   super_admin - everything
//   ops         - orders (cancel, reassign), restaurants, riders (status, selfie review), catalog,
//                 customer block/unblock; NOT settlement, wallet credit, coupons, CSV export, admin management
//   support     - POST /orders/:id/cancel only
// requireRole answers 403 { code: "forbidden_role" }.
const superOnly = requireRole("super_admin");
const staff = requireRole("super_admin", "ops");

router.get("/dashboard", adminController.dashboardSummary);

// Orders
router.get("/orders", adminOrders.listOrders);
router.get("/orders/:id", adminOrders.getOrder);
router.post("/orders/:id/cancel", adminOrders.cancelOrder);
router.post("/orders/:id/reassign-rider", staff, adminOrders.reassignRider);

// Riders
router.get("/riders", adminController.listRiders);
router.get("/riders/:id", adminController.getRider);
router.get("/riders/:id/agreement-selfie", adminController.getRiderAgreementSelfie);
router.post("/riders/:id/verification", staff, adminController.reviewRiderVerification);
router.patch("/riders/:id", staff, adminController.updateRiderStatus);
router.post("/riders/:riderId/settle", superOnly, adminController.settleRider);
router.get("/settlements", adminController.listSettlements);

// Categories & items
router.get("/categories", adminCategories.listCategories);
router.patch("/categories/:id", staff, adminCategories.updateCategory);
router.post("/categories/:id/merge", staff, adminCategories.mergeCategories);
router.get("/items", adminCategories.listItems);

// Coupons
router.post("/coupons", superOnly, adminCoupons.createCoupon);
router.get("/coupons", adminCoupons.listCoupons);
router.patch("/coupons/:id", superOnly, adminCoupons.updateCoupon);

// Customers
router.get("/customers/export.csv", superOnly, adminCustomers.exportCustomersCsv); // before /:id — "export.csv" would otherwise look like an :id
router.get("/customers", adminCustomers.listCustomers);
router.get("/customers/:id", adminCustomers.getCustomer);
router.patch("/customers/:id", staff, adminCustomers.updateCustomerStatus);
router.post("/customers/:id/wallet-credit", superOnly, adminCustomers.creditCustomerWallet);

// Admin accounts (super_admin only) + self-service password change (any admin)
router.get("/admins", superOnly, adminAdmins.listAdmins);
router.post("/admins", superOnly, adminAdmins.createAdmin);
router.patch("/admins/:id", superOnly, adminAdmins.updateAdmin);
router.post("/me/password", adminAdmins.changeMyPassword);

module.exports = router;
