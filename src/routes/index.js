const express = require("express");
const authRoutes = require("./auth.routes");
const catalogRoutes = require("./catalog.routes");
const restaurantSelfRoutes = require("./restaurantSelf.routes");
const restaurantRoutes = require("./restaurant.routes");
const orderRoutes = require("./order.routes");
const walletRoutes = require("./wallet.routes");
const riderRoutes = require("./rider.routes");
const adminRoutes = require("./admin.routes");
const addressRoutes = require("./address.routes");
const profileRoutes = require("./profile.routes");
const cartRoutes = require("./cart.routes");
const paymentRoutes = require("./payment.routes");
const favoriteRoutes = require("./favorite.routes");
const notificationRoutes = require("./notification.routes");
const uploadRoutes = require("./upload.routes");
const couponRoutes = require("./coupon.routes");
const partnerDocumentRoutes = require("./partnerDocuments.routes");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/restaurants", restaurantSelfRoutes);
router.use("/", catalogRoutes); // /categories, /items — mounted at root since they're not namespaced resources
router.use("/admin/restaurants", restaurantRoutes);
router.use("/orders", orderRoutes);
router.use("/wallet", walletRoutes);
router.use("/riders", riderRoutes);
router.use("/admin", adminRoutes);
router.use("/addresses", addressRoutes);
router.use("/profile", profileRoutes);
router.use("/cart", cartRoutes);
router.use("/payments/razorpay/webhook", require("./razorpayWebhook.routes")); // before /payments: that router requires a customer JWT
router.use("/payments", paymentRoutes);
router.use("/favorites", favoriteRoutes);
router.use("/notifications", notificationRoutes);
router.use("/uploads", uploadRoutes);
router.use("/coupons", couponRoutes);
router.get("/downloads", require("../controllers/kitchenEarnings.controller").download); // public: the signed token in ?t= is the authorisation (kitchen report downloads opened in the phone browser)
router.get("/support/contact", require("../controllers/partnerSupport.controller").getContact); // public (the login screen shows it); before /support, which needs a customer token
router.use("/support", require("./support.routes")); // customer complaints with a reference number
router.get("/onboarding-slides", require("../controllers/onboardingSlides.controller").listPublic); // public: the Customer app's intro slides, shown before login
router.get("/app-notice", require("../controllers/appNotices.controller").getLive); // public: the Customer app's popup notice (newest live one or null)
router.use("/partner", partnerDocumentRoutes); // partner.fengle.in document portal

// Dev/test tools (last-otp, advance order, add credit) exist only outside production.
if (process.env.NODE_ENV !== "production") {
  router.use("/dev", require("./dev.routes"));
}

module.exports = router;
