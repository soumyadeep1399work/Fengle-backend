const db = require("../config/db");
const { isEligible } = require("../services/coupon.service");

/**
 * GET /coupons/mine — every currently active/in-date coupon this customer is
 * eligible for, per its target_type. `already_used` means "at
 * usage_limit_per_user for this coupon" (the app greys out Apply), not
 * merely "used once ever". A coupon that's hit its total_usage_limit is left
 * out entirely rather than shown as unusable.
 */
async function listMyCoupons(req, res) {
  const customerId = req.auth.id;
  const now = new Date();

  const coupons = await db("coupons")
    .where({ is_active: true })
    .andWhere((qb) => qb.whereNull("valid_from").orWhere("valid_from", "<=", now))
    .andWhere((qb) => qb.whereNull("valid_until").orWhere("valid_until", ">=", now))
    .orderBy("created_at", "desc");

  const eligible = [];
  for (const coupon of coupons) {
    if (!(await isEligible(coupon, customerId))) continue;

    if (coupon.total_usage_limit != null) {
      const { n: totalUsed } = await db("coupon_redemptions").where({ coupon_id: coupon.id }).count({ n: "*" }).first();
      if (Number(totalUsed) >= coupon.total_usage_limit) continue;
    }

    const { n: usedByCustomer } = await db("coupon_redemptions").where({ coupon_id: coupon.id, user_id: customerId }).count({ n: "*" }).first();

    eligible.push({
      id: coupon.id,
      code: coupon.code,
      title: coupon.title,
      description: coupon.description,
      discount_type: coupon.discount_type,
      discount_value: Number(coupon.discount_value),
      max_discount_amount: coupon.max_discount_amount != null ? Number(coupon.max_discount_amount) : null,
      min_order_value: Number(coupon.min_order_value),
      valid_until: coupon.valid_until,
      already_used: Number(usedByCustomer) >= coupon.usage_limit_per_user,
    });
  }

  res.json({ coupons: eligible });
}

module.exports = { listMyCoupons };
