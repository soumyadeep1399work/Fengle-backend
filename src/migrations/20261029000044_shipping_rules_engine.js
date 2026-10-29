// Shipping charges engine (client decision 2026-10-29): every delivery fee (what the customer pays) and every rider payout
// is an admin-managed rule, WooCommerce-style: zones + rules with conditions (distance bands, order value, time of day /
// day of week, area). Replaces routing.computeDeliveryFee and the single-row rider_pay_config (kept only as history).
//
// Seeded so NOTHING changes on deploy:
//   customer_fee  -> one base rule {bands:[0..null @ 5/km], after_kitchen_radius:true} = today's "free inside the kitchen's
//                    radius_km, then Rs 5/km beyond".
//   rider_pay     -> the live rider_pay_config row turned into rules: a base rule (flat base_payout + per-km bands, two bands when
//                    a tier is set), a `min` rule from min_payout, an `add` rule from incentive_per_delivery.
//                    (One nuance: the engine applies `add` rules before `min`, so a non-zero incentive now counts toward the
//                    minimum. The live config has incentive 0, where payouts are identical.)
exports.up = async function (knex) {
  await knex.schema.createTable("shipping_zones", (table) => {
    table.increments("id").primary();
    table.string("name", 100).notNullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.integer("priority").notNullable().defaultTo(0); // lower = checked first
    table.text("match").notNullable(); // JSON { pincodes: [], circles: [{ lat, lng, radius_km }] }
    table.boolean("is_deleted").notNullable().defaultTo(false);
    table.integer("created_by_admin_id").unsigned().nullable();
    table.timestamps(true, true);
  });

  await knex.schema.createTable("shipping_rules", (table) => {
    table.increments("id").primary();
    table.enu("kind", ["customer_fee", "rider_pay"]).notNullable();
    table.integer("zone_id").unsigned().nullable(); // null = applies everywhere
    table.string("name", 100).notNullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.integer("priority").notNullable().defaultTo(0);
    table.enu("type", ["base", "add", "free", "min", "max"]).notNullable();
    table.text("conditions").notNullable(); // JSON
    table.text("charge").notNullable(); // JSON
    table.timestamp("valid_from").nullable();
    table.timestamp("valid_to").nullable();
    table.boolean("is_deleted").notNullable().defaultTo(false);
    table.integer("created_by_admin_id").unsigned().nullable();
    table.timestamps(true, true);
    table.index(["kind", "is_deleted", "is_active"]);
  });

  // Append-only audit trail for rules AND zones: what an admin changed, when, before and after.
  await knex.schema.createTable("shipping_history", (table) => {
    table.increments("id").primary();
    table.enu("entity", ["rule", "zone"]).notNullable();
    table.integer("entity_id").unsigned().notNullable();
    table.string("kind", 20).nullable();
    table.enu("action", ["create", "update", "delete", "reorder"]).notNullable();
    table.text("before").nullable();
    table.text("after").nullable();
    table.integer("admin_id").unsigned().nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["entity", "entity_id"]);
    table.index(["kind", "created_at"]);
  });

  await knex.schema.alterTable("orders", (table) => {
    table.text("delivery_fee_breakdown").nullable(); // JSON: how the customer's delivery fee was worked out (admin-only)
  });

  const J = JSON.stringify;
  const seed = (row) => knex("shipping_rules").insert({ zone_id: null, is_active: true, conditions: J({}), ...row });

  await seed({
    kind: "customer_fee", name: "Standard delivery fee", priority: 1, type: "base",
    charge: J({ bands: [{ from_km: 0, to_km: null, per_km: 5 }], after_kitchen_radius: true }),
  });

  const cfg = await knex("rider_pay_config").orderBy("id", "desc").first();
  const base = cfg ? Number(cfg.base_payout) : 0;
  const perKm = cfg ? Number(cfg.per_km_rate) : Number(process.env.RIDER_RATE_PER_KM) || 8;
  const minPay = cfg ? Number(cfg.min_payout) : Number(process.env.RIDER_MIN_EARNING_PER_DELIVERY) || 15;
  const incentive = cfg ? Number(cfg.incentive_per_delivery) : 0;
  const tier = cfg && cfg.tier_km != null && Number(cfg.tier_km) > 0 && cfg.per_km_rate_after_tier != null ? Number(cfg.tier_km) : null;
  const bands = tier
    ? [{ from_km: 0, to_km: tier, per_km: perKm }, { from_km: tier, to_km: null, per_km: Number(cfg.per_km_rate_after_tier) }]
    : [{ from_km: 0, to_km: null, per_km: perKm }];
  const baseCharge = { bands };
  if (base > 0) baseCharge.flat = base;
  await seed({ kind: "rider_pay", name: "Rider base pay", priority: 1, type: "base", charge: J(baseCharge) });
  if (minPay > 0) await seed({ kind: "rider_pay", name: "Minimum rider pay", priority: 2, type: "min", charge: J({ amount: minPay }) });
  if (incentive > 0) await seed({ kind: "rider_pay", name: "Delivery incentive", priority: 3, type: "add", charge: J({ flat: incentive }) });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("delivery_fee_breakdown");
  });
  await knex.schema.dropTableIfExists("shipping_history");
  await knex.schema.dropTableIfExists("shipping_rules");
  await knex.schema.dropTableIfExists("shipping_zones");
};
