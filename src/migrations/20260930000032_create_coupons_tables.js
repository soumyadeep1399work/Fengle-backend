// Targeted coupon system (client request, 2026-09-30): admin creates a
// coupon with an audience-targeting rule (not just "everyone"), customers
// apply it at checkout. coupon_redemptions is the usage-limit + audit trail.
// orders.coupon_code is a snapshot (same "never rewrite history" principle
// as the item-name snapshot) — it survives a later coupon rename/delete.
exports.up = async function (knex) {
  await knex.schema.createTable("coupons", (table) => {
    table.increments("id").primary();
    table.string("code", 40).notNullable().unique();
    table.string("title", 120).notNullable();
    table.text("description").nullable();
    table.enu("discount_type", ["flat", "percent"]).notNullable();
    table.decimal("discount_value", 10, 2).notNullable();
    table.decimal("max_discount_amount", 10, 2).nullable(); // percent-type cap; ignored for flat
    table.decimal("min_order_value", 10, 2).notNullable().defaultTo(0);
    table.enu("target_type", ["all", "new_users", "inactive_users", "selected_users"]).notNullable().defaultTo("all");
    table.json("target_meta").nullable(); // { days } for inactive_users, { phones: [] } for selected_users
    table.integer("usage_limit_per_user").unsigned().notNullable().defaultTo(1);
    table.integer("total_usage_limit").unsigned().nullable(); // null = unlimited
    table.timestamp("valid_from").nullable();
    table.timestamp("valid_until").nullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamps(true, true);
  });

  await knex.schema.createTable("coupon_redemptions", (table) => {
    table.increments("id").primary();
    table.integer("coupon_id").unsigned().notNullable()
      .references("id").inTable("coupons").onDelete("CASCADE");
    table.integer("user_id").unsigned().notNullable()
      .references("id").inTable("users").onDelete("CASCADE");
    table.integer("order_id").unsigned().notNullable()
      .references("id").inTable("orders").onDelete("CASCADE");
    table.decimal("discount_amount", 10, 2).notNullable();
    table.timestamp("redeemed_at").notNullable().defaultTo(knex.fn.now());
    table.index(["coupon_id", "user_id"]);
  });

  await knex.schema.alterTable("orders", (table) => {
    table.integer("coupon_id").unsigned().nullable()
      .references("id").inTable("coupons").onDelete("SET NULL");
    table.string("coupon_code", 40).nullable();
    table.decimal("coupon_discount_amount", 10, 2).notNullable().defaultTo(0);
  });
};

exports.down = async function (knex) {
  // MySQL refuses to drop a column while its foreign key constraint still
  // exists — has to go first, in its own alterTable call.
  await knex.schema.alterTable("orders", (table) => {
    table.dropForeign("coupon_id");
  });
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("coupon_id");
    table.dropColumn("coupon_code");
    table.dropColumn("coupon_discount_amount");
  });
  await knex.schema.dropTableIfExists("coupon_redemptions");
  await knex.schema.dropTableIfExists("coupons");
};
