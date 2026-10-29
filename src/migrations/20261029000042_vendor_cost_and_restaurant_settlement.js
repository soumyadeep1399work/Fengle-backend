// Restaurant settlement by vendor cost (client decision 2026-10-29) — replaces the commission model for
// paying kitchens.
//
// items.vendor_cost: what Fengle pays a kitchen for ONE unit of the dish (internal; never shown to
//   customers or kitchens). One cost per dish, the same for every kitchen; see vendorCost.service.js
//   for the seam where a per-kitchen override can be added later.
// order_items.vendor_cost: snapshot at placement, so a later cost change never rewrites an old order.
// orders.restaurant_payable: what Fengle owes the kitchen for the order = sum(vendor_cost x quantity) over
//   its confirmed lines. orders.payable_estimated = at least one line had no vendor cost, so that line
//   fell back to the old formula (line subtotal minus the kitchen's commission %). Fengle bears all
//   discounts (coupons and dish offers), so neither reduces the payable.
//   Orders placed before this migration are backfilled with the OLD formula (item_total - commission_amount)
//   and flagged estimated, so every order has a payable and admins can see which ones are guesses.
// restaurant_payments: money Fengle actually paid a kitchen (recorded by an admin, whenever one is made).
// restaurant_adjustments: signed corrections agreed off-system (+ owed to the kitchen, - deduction).
exports.up = async function (knex) {
  await knex.schema.alterTable("items", (table) => {
    table.decimal("vendor_cost", 10, 2).nullable();
  });
  await knex.schema.alterTable("order_items", (table) => {
    table.decimal("vendor_cost", 10, 2).nullable();
  });
  await knex.schema.alterTable("orders", (table) => {
    table.decimal("restaurant_payable", 10, 2).nullable();
    table.boolean("payable_estimated").notNullable().defaultTo(false);
  });
  await knex.raw("UPDATE orders SET restaurant_payable = item_total - commission_amount, payable_estimated = 1 WHERE restaurant_payable IS NULL");

  await knex.schema.createTable("restaurant_payments", (table) => {
    table.increments("id").primary();
    table.integer("restaurant_id").unsigned().notNullable().references("id").inTable("restaurants");
    table.decimal("amount", 12, 2).notNullable();
    table.timestamp("paid_at").notNullable().defaultTo(knex.fn.now());
    table.string("reference", 100).nullable(); // UTR / transaction id; unique per kitchen so a double-submit can't pay twice
    table.enu("method", ["bank_transfer", "upi", "cash", "other"]).notNullable().defaultTo("bank_transfer");
    table.text("notes").nullable();
    table.integer("recorded_by_admin_id").unsigned().nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["restaurant_id", "reference"]);
    table.index(["restaurant_id", "paid_at"]);
  });

  await knex.schema.createTable("restaurant_adjustments", (table) => {
    table.increments("id").primary();
    table.integer("restaurant_id").unsigned().notNullable().references("id").inTable("restaurants");
    table.decimal("amount", 12, 2).notNullable(); // + owed to the kitchen, - deduction
    table.string("reason", 255).notNullable();
    table.integer("related_order_id").unsigned().nullable();
    table.integer("created_by_admin_id").unsigned().nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["restaurant_id", "created_at"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("restaurant_adjustments");
  await knex.schema.dropTableIfExists("restaurant_payments");
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("restaurant_payable");
    table.dropColumn("payable_estimated");
  });
  await knex.schema.alterTable("order_items", (table) => {
    table.dropColumn("vendor_cost");
  });
  await knex.schema.alterTable("items", (table) => {
    table.dropColumn("vendor_cost");
  });
};
