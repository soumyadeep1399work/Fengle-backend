// Admin-configurable rider pay (client checklist item 8, 2026-10-28). Replaces the
// RIDER_RATE_PER_KM / RIDER_MIN_EARNING_PER_DELIVERY env placeholders.
//
// rider_pay_config is an append-only history: every PUT adds a row, the newest row is the
// live config. The first row reproduces what the env placeholders paid, so nothing changes
// until an admin edits it.
//
// When an order is delivered, the payout is computed once and frozen on the order
// (rider_payout + a readable breakdown + which config row was used), so a later rate change
// never rewrites what a rider already earned. Orders delivered before this migration have
// NULL here and settlement falls back to the current formula for them.
exports.up = async function (knex) {
  await knex.schema.createTable("rider_pay_config", (table) => {
    table.increments("id").primary();
    table.decimal("base_payout", 10, 2).notNullable().defaultTo(0);
    table.decimal("per_km_rate", 10, 2).notNullable().defaultTo(0);
    table.decimal("min_payout", 10, 2).notNullable().defaultTo(0);
    table.decimal("incentive_per_delivery", 10, 2).notNullable().defaultTo(0);
    table.integer("created_by_admin_id").unsigned().nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex("rider_pay_config").insert({
    base_payout: 0,
    per_km_rate: Number(process.env.RIDER_RATE_PER_KM) || 8,
    min_payout: Number(process.env.RIDER_MIN_EARNING_PER_DELIVERY) || 15,
    incentive_per_delivery: 0,
    created_by_admin_id: null,
  });

  await knex.schema.alterTable("orders", (table) => {
    table.decimal("rider_payout", 10, 2).nullable();
    table.text("rider_payout_breakdown").nullable(); // JSON text (MariaDB/MySQL behave the same for TEXT)
    table.integer("rider_pay_config_id").unsigned().nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("rider_payout");
    table.dropColumn("rider_payout_breakdown");
    table.dropColumn("rider_pay_config_id");
  });
  await knex.schema.dropTableIfExists("rider_pay_config");
};
