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
router.use("/payments", paymentRoutes);
router.use("/favorites", favoriteRoutes);
router.use("/notifications", notificationRoutes);
router.use("/uploads", uploadRoutes);
router.use("/coupons", couponRoutes);

if (process.env.NODE_ENV !== "production") {
  router.use("/dev", require("./dev.routes"));
}

module.exports = router;
