// Shared by POST /cart/quote (preview, no persistence) and POST /orders
// (final, persists the redemption) so the two can never disagree about
// whether a code applies or how much it's worth.
const db = require("../config/db");

const TARGET_TYPES = ["all", "new_users", "inactive_users", "selected_users"];
const DISCOUNT_TYPES = ["flat", "percent"];
const DEFAULT_INACTIVE_DAYS = 30;

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function parseMeta(raw) {
  if (!raw) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * "new_users"/"inactive_users" count ANY order ever placed (including a
 * cancelled one) as disqualifying — a customer who tried and had it cancelled
 * isn't meaningfully "new" or "inactive" anymore. A documented assumption,
 * not a spec requirement (none was given).
 */
async function isEligible(coupon, customerId) {
  if (coupon.target_type === "all") return true;
  const meta = parseMeta(coupon.target_meta);

  if (coupon.target_type === "selected_users") {
    const phones = Array.isArray(meta.phones) ? meta.phones : [];
    const customer = await db("users").where({ id: customerId }).select("phone").first();
    return Boolean(customer) && phones.includes(customer.phone);
  }

  if (coupon.target_type === "new_users") {
    const { n } = await db("orders").where({ customer_id: customerId }).count({ n: "*" }).first();
    return Number(n) === 0;
  }

  if (coupon.target_type === "inactive_users") {
    const days = Number(meta.days) || DEFAULT_INACTIVE_DAYS;
    const recent = await db("orders")
      .where({ customer_id: customerId })
      .andWhere("created_at", ">=", db.raw("DATE_SUB(NOW(), INTERVAL ? DAY)", [days]))
      .first();
    return !recent;
  }

  return false;
}

/**
 * percent applies to item_total (food subtotal), not delivery/tax — capped by
 * max_discount_amount if set. flat is a straight rupee amount. Either way the
 * discount never exceeds item_total (a coupon can't zero out delivery/tax).
 * GST itself is computed on the full, pre-discount item_total — the discount
 * is a platform-funded promo applied after tax, not a menu-price reduction
 * (also means it never reduces the restaurant's commission/payout).
 * All of this is a documented default, not a client-confirmed spec.
 */
function computeDiscount(coupon, itemTotal) {
  let discount;
  if (coupon.discount_type === "flat") {
    discount = Number(coupon.discount_value);
  } else {
    discount = itemTotal * (Number(coupon.discount_value) / 100);
    if (coupon.max_discount_amount != null) discount = Math.min(discount, Number(coupon.max_discount_amount));
  }
  discount = Math.max(0, Math.min(discount, itemTotal));
  return Number(discount.toFixed(2));
}

/**
 * Validates a coupon code for a customer's cart. Returns { coupon, discount }
 * on success or { error } (a user-facing reason string) on failure — never
 * throws for an invalid/ineligible code, only for a genuine DB error.
 *
 * Pass `trx` when called from inside an order-placement transaction: it locks
 * the coupon row (FOR UPDATE) so two near-simultaneous redemptions of the
 * last unit of a limited coupon can't both pass the usage-limit check.
 */
async function validateCoupon({ code, customerId, itemTotal, trx }) {
  const q = trx || db;
  const normalized = normalizeCode(code);
  if (!normalized) return { error: "Coupon code is required" };

  const couponQuery = q("coupons").whereRaw("UPPER(code) = ?", [normalized]);
  if (trx) couponQuery.forUpdate();
  const coupon = await couponQuery.first();
  if (!coupon) return { error: "Invalid coupon code" };
  if (!coupon.is_active) return { error: "This coupon is no longer active" };

  const now = new Date();
  if (coupon.valid_from && now < new Date(coupon.valid_from)) return { error: "This coupon isn't active yet" };
  if (coupon.valid_until && now > new Date(coupon.valid_until)) return { error: "This coupon has expired" };

  if (itemTotal < Number(coupon.min_order_value)) {
    return { error: `Minimum order value for this coupon is ₹${Number(coupon.min_order_value).toFixed(0)}` };
  }

  // Usage limits are checked BEFORE eligibility on purpose: redeeming a
  // "new_users" coupon gives the customer their first order, which flips
  // their own future eligibility to false — checking eligibility first would
  // report the less specific "not eligible" instead of "already used" on a
  // second attempt with the exact same coupon.
  if (coupon.total_usage_limit != null) {
    const { n } = await q("coupon_redemptions").where({ coupon_id: coupon.id }).count({ n: "*" }).first();
    if (Number(n) >= coupon.total_usage_limit) return { error: "This coupon has reached its usage limit" };
  }

  const { n: usedByCustomer } = await q("coupon_redemptions").where({ coupon_id: coupon.id, user_id: customerId }).count({ n: "*" }).first();
  if (Number(usedByCustomer) >= coupon.usage_limit_per_user) {
    return { error: "You've already used this coupon the maximum number of times" };
  }

  if (!(await isEligible(coupon, customerId))) {
    return { error: "You're not eligible for this coupon" };
  }

  return { coupon, discount: computeDiscount(coupon, itemTotal) };
}

/**
 * Bulk equivalent of isEligible(), for the push-notification fan-out at
 * coupon creation — doing that one customer at a time via isEligible() would
 * be O(customers) queries for "all"/"inactive_users" targeting. Kept as a
 * separate SQL-side implementation rather than looping isEligible(); the two
 * must be kept in sync by hand if the targeting rules ever change. Excludes
 * blocked customers (a blocked customer can't place an order anyway, so a
 * coupon push to them is wasted, not just harmless).
 */
async function getEligibleCustomerIds(coupon) {
  const meta = parseMeta(coupon.target_meta);

  if (coupon.target_type === "all") {
    return (await db("users").where({ status: "active" }).select("id")).map((r) => r.id);
  }

  if (coupon.target_type === "selected_users") {
    const phones = Array.isArray(meta.phones) ? meta.phones : [];
    if (!phones.length) return [];
    return (await db("users").where({ status: "active" }).whereIn("phone", phones).select("id")).map((r) => r.id);
  }

  if (coupon.target_type === "new_users") {
    const rows = await db("users")
      .where({ status: "active" })
      .whereNotExists(function () {
        this.select("*").from("orders").whereRaw("orders.customer_id = users.id");
      })
      .select("id");
    return rows.map((r) => r.id);
  }

  if (coupon.target_type === "inactive_users") {
    const days = Number(meta.days) || DEFAULT_INACTIVE_DAYS;
    const rows = await db("users")
      .where({ status: "active" })
      .whereNotExists(function () {
        this.select("*").from("orders")
          .whereRaw("orders.customer_id = users.id")
          .andWhere("orders.created_at", ">=", db.raw("DATE_SUB(NOW(), INTERVAL ? DAY)", [days]));
      })
      .select("id");
    return rows.map((r) => r.id);
  }

  return [];
}

module.exports = { validateCoupon, computeDiscount, isEligible, getEligibleCustomerIds, normalizeCode, TARGET_TYPES, DISCOUNT_TYPES };
