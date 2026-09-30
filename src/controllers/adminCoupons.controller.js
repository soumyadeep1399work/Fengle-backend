const db = require("../config/db");
const { paginationParams } = require("../utils/pagination");
const couponService = require("../services/coupon.service");
const { sendPromoBroadcast, notifyLater } = require("../services/push.service");

const { TARGET_TYPES, DISCOUNT_TYPES } = couponService;

function serializeCoupon(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    discount_type: row.discount_type,
    discount_value: Number(row.discount_value),
    max_discount_amount: row.max_discount_amount != null ? Number(row.max_discount_amount) : null,
    min_order_value: Number(row.min_order_value),
    target_type: row.target_type,
    target_meta: row.target_meta ? (typeof row.target_meta === "string" ? JSON.parse(row.target_meta) : row.target_meta) : null,
    usage_limit_per_user: row.usage_limit_per_user,
    total_usage_limit: row.total_usage_limit,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateTargetMeta(targetType, targetMeta) {
  if (targetType !== "selected_users") return null;
  if (!targetMeta || !Array.isArray(targetMeta.phones) || targetMeta.phones.length === 0) {
    return "target_meta.phones (a non-empty array) is required for target_type 'selected_users'";
  }
  return null;
}

/**
 * POST /admin/coupons — creates the coupon and, if it's immediately live
 * (is_active && valid_from is now-or-past), fans a push out to every
 * eligible-by-target_type customer who hasn't turned "Offers & news" off.
 * A later PATCH does NOT re-trigger a push — only creation does, per spec.
 */
async function createCoupon(req, res) {
  const {
    code, title, description, discount_type, discount_value, max_discount_amount,
    min_order_value, target_type, target_meta, usage_limit_per_user, total_usage_limit,
    valid_from, valid_until, is_active,
  } = req.body || {};

  if (!code || !String(code).trim()) return res.status(400).json({ error: "code is required" });
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
  if (!DISCOUNT_TYPES.includes(discount_type)) {
    return res.status(400).json({ error: `discount_type must be one of: ${DISCOUNT_TYPES.join(", ")}` });
  }
  if (discount_value == null || Number(discount_value) <= 0) {
    return res.status(400).json({ error: "discount_value must be a positive number" });
  }
  const targetType = target_type || "all";
  if (!TARGET_TYPES.includes(targetType)) {
    return res.status(400).json({ error: `target_type must be one of: ${TARGET_TYPES.join(", ")}` });
  }
  const targetMetaError = validateTargetMeta(targetType, target_meta);
  if (targetMetaError) return res.status(400).json({ error: targetMetaError });

  const normalizedCode = couponService.normalizeCode(code);
  const existing = await db("coupons").whereRaw("UPPER(code) = ?", [normalizedCode]).first();
  if (existing) return res.status(409).json({ error: "A coupon with this code already exists" });

  const isActive = is_active !== false; // default true
  const [id] = await db("coupons").insert({
    code: normalizedCode,
    title: String(title).trim(),
    description: description || null,
    discount_type,
    discount_value: Number(discount_value),
    max_discount_amount: max_discount_amount != null ? Number(max_discount_amount) : null,
    min_order_value: min_order_value != null ? Number(min_order_value) : 0,
    target_type: targetType,
    target_meta: target_meta ? JSON.stringify(target_meta) : null,
    usage_limit_per_user: usage_limit_per_user != null ? Number(usage_limit_per_user) : 1,
    total_usage_limit: total_usage_limit != null ? Number(total_usage_limit) : null,
    valid_from: valid_from ? new Date(valid_from) : null,
    valid_until: valid_until ? new Date(valid_until) : null,
    is_active: isActive,
  });

  const coupon = await db("coupons").where({ id }).first();

  const isLiveNow = isActive && (!coupon.valid_from || new Date(coupon.valid_from) <= new Date());
  if (isLiveNow) {
    notifyLater(async () => {
      const customerIds = await couponService.getEligibleCustomerIds(coupon);
      await sendPromoBroadcast(customerIds, {
        title: coupon.title,
        body: coupon.description || `New offer: ${coupon.title}`,
        data: { type: "coupon" },
      });
    });
  }

  res.status(201).json({ coupon: serializeCoupon(coupon) });
}

/** GET /admin/coupons?page=&limit= — each row adds redemption_count. */
async function listCoupons(req, res) {
  const { page, limit, offset } = paginationParams(req);

  const { n: total } = await db("coupons").count({ n: "*" }).first();
  const rows = await db("coupons").orderBy("created_at", "desc").limit(limit).offset(offset);

  const couponIds = rows.map((r) => r.id);
  const redemptionRows = couponIds.length
    ? await db("coupon_redemptions").whereIn("coupon_id", couponIds).select("coupon_id").count({ n: "*" }).groupBy("coupon_id")
    : [];
  const redemptionsByCoupon = Object.fromEntries(redemptionRows.map((r) => [r.coupon_id, Number(r.n)]));

  res.json({
    coupons: rows.map((r) => ({ ...serializeCoupon(r), redemption_count: redemptionsByCoupon[r.id] || 0 })),
    page, limit, total: Number(total),
  });
}

/**
 * PATCH /admin/coupons/:id — edit any creatable field, or just toggle
 * is_active. Never re-triggers the creation push, even if this flips
 * is_active from false to true.
 */
async function updateCoupon(req, res) {
  const { id } = req.params;
  const existing = await db("coupons").where({ id }).first();
  if (!existing) return res.status(404).json({ error: "Coupon not found" });

  const {
    code, title, description, discount_type, discount_value, max_discount_amount,
    min_order_value, target_type, target_meta, usage_limit_per_user, total_usage_limit,
    valid_from, valid_until, is_active,
  } = req.body || {};

  const updates = {};

  if (code !== undefined) {
    const normalizedCode = couponService.normalizeCode(code);
    if (!normalizedCode) return res.status(400).json({ error: "code cannot be empty" });
    const clash = await db("coupons").whereRaw("UPPER(code) = ?", [normalizedCode]).andWhereNot({ id }).first();
    if (clash) return res.status(409).json({ error: "A coupon with this code already exists" });
    updates.code = normalizedCode;
  }
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: "title cannot be empty" });
    updates.title = String(title).trim();
  }
  if (description !== undefined) updates.description = description;
  if (discount_type !== undefined) {
    if (!DISCOUNT_TYPES.includes(discount_type)) return res.status(400).json({ error: `discount_type must be one of: ${DISCOUNT_TYPES.join(", ")}` });
    updates.discount_type = discount_type;
  }
  if (discount_value !== undefined) {
    if (Number(discount_value) <= 0) return res.status(400).json({ error: "discount_value must be a positive number" });
    updates.discount_value = Number(discount_value);
  }
  if (max_discount_amount !== undefined) updates.max_discount_amount = max_discount_amount != null ? Number(max_discount_amount) : null;
  if (min_order_value !== undefined) updates.min_order_value = Number(min_order_value);
  if (target_type !== undefined) {
    if (!TARGET_TYPES.includes(target_type)) return res.status(400).json({ error: `target_type must be one of: ${TARGET_TYPES.join(", ")}` });
    const effectiveMeta = target_meta !== undefined ? target_meta : (existing.target_meta && JSON.parse(existing.target_meta));
    const targetMetaError = validateTargetMeta(target_type, effectiveMeta);
    if (targetMetaError) return res.status(400).json({ error: targetMetaError });
    updates.target_type = target_type;
  }
  if (target_meta !== undefined) updates.target_meta = target_meta ? JSON.stringify(target_meta) : null;
  if (usage_limit_per_user !== undefined) updates.usage_limit_per_user = Number(usage_limit_per_user);
  if (total_usage_limit !== undefined) updates.total_usage_limit = total_usage_limit != null ? Number(total_usage_limit) : null;
  if (valid_from !== undefined) updates.valid_from = valid_from ? new Date(valid_from) : null;
  if (valid_until !== undefined) updates.valid_until = valid_until ? new Date(valid_until) : null;
  if (is_active !== undefined) updates.is_active = Boolean(is_active);

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });

  await db("coupons").where({ id }).update(updates);
  const coupon = await db("coupons").where({ id }).first();
  res.json({ coupon: serializeCoupon(coupon) });
}

module.exports = { createCoupon, listCoupons, updateCoupon };
