const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth.middleware");
const adminController = require("../controllers/admin.controller");
const adminOrders = require("../controllers/adminOrders.controller");
const adminCustomers = require("../controllers/adminCustomers.controller");
const adminCategories = require("../controllers/adminCategories.controller");
const adminCoupons = require("../controllers/adminCoupons.controller");
const adminAdmins = require("../controllers/adminAdmins.controller");
const adminSettings = require("../controllers/adminSettings.controller");
const adminCod = require("../controllers/adminCod.controller");
const adminFinance = require("../controllers/adminFinance.controller");
const adminNotifications = require("../controllers/adminNotifications.controller");
const adminRestSettlement = require("../controllers/adminRestaurantSettlement.controller");
const partnerDocuments = require("../controllers/partnerDocuments.controller");

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

// COD cash: record what riders hand over (ops + super_admin); the history and the reconciliation report are open to every role.
router.post("/riders/:id/cash-handovers", staff, adminCod.createCashHandover);
router.get("/cash-handovers", adminCod.listCashHandovers);
router.get("/cod/reconciliation", adminCod.codReconciliation);
router.get("/cod/reconciliation.csv", adminCod.codReconciliationCsv);
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

// Partner documents (KYC / licences). Every role may view; approve/reject is ops + super_admin,
// same as the selfie review.
router.get("/documents", partnerDocuments.listDocuments);
router.get("/documents/:id/file", partnerDocuments.getDocumentFile);
router.post("/documents/:id/review", staff, partnerDocuments.reviewDocument);
router.get("/documents/:ownerType/:ownerId", partnerDocuments.getOwnerDocuments);

// Rider pay: every role can read it; only a super_admin can change it.
router.get("/settings/rider-pay", adminSettings.getRiderPay);
router.put("/settings/rider-pay", superOnly, adminSettings.updateRiderPay);

// Restaurant settlement (vendor-cost model): what each kitchen is owed, payments and adjustments. super_admin + ops only
// (statements show what Fengle pays per dish); support never sees it.
router.get("/restaurant-settlements", staff, adminRestSettlement.overview);
router.get("/restaurant-settlements.csv", staff, adminRestSettlement.overviewCsv);
router.get("/restaurants/:id/settlement", staff, adminRestSettlement.statement);
router.get("/restaurants/:id/settlement.csv", staff, adminRestSettlement.statementCsv);
router.post("/restaurants/:id/payments", staff, adminRestSettlement.createPayment);
router.get("/restaurant-payments", staff, adminRestSettlement.listPayments);
router.post("/restaurants/:id/adjustments", staff, adminRestSettlement.createAdjustment);
router.get("/restaurant-adjustments", staff, adminRestSettlement.listAdjustments);

// Notification centre (super_admin only): compose, schedule, cancel and review push campaigns to customers.
router.post("/notifications/preview", superOnly, adminNotifications.preview);
router.post("/notifications", superOnly, adminNotifications.createCampaign);
router.get("/notifications", superOnly, adminNotifications.listCampaigns);
router.get("/notifications/:id", superOnly, adminNotifications.getCampaign);
router.post("/notifications/:id/cancel", superOnly, adminNotifications.cancelCampaign);

// Finance (super_admin only): expenses CRUD, profit & loss, and its CSVs.
router.post("/expenses", superOnly, adminFinance.createExpense);
router.get("/expenses", superOnly, adminFinance.listExpenses);
router.patch("/expenses/:id", superOnly, adminFinance.updateExpense);
router.delete("/expenses/:id", superOnly, adminFinance.deleteExpense);
router.get("/finance/pnl", superOnly, adminFinance.pnl);
router.get("/finance/pnl.csv", superOnly, adminFinance.pnlCsv);
router.get("/finance/orders.csv", superOnly, adminFinance.ordersCsv);
router.get("/finance/products", superOnly, adminFinance.products);
router.get("/finance/products.csv", superOnly, adminFinance.productsCsv);

// Admin accounts (super_admin only) + self-service password change (any admin)
router.get("/admins", superOnly, adminAdmins.listAdmins);
router.post("/admins", superOnly, adminAdmins.createAdmin);
router.patch("/admins/:id", superOnly, adminAdmins.updateAdmin);
router.post("/me/password", adminAdmins.changeMyPassword);

module.exports = router;
