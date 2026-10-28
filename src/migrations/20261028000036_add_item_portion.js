// Every dish shows its quantity ("3 pc", "500 gm") — client requirement 2026-10-28.
// items.quantity_value/quantity_unit are the live values; order_items gets its own
// snapshot (portion_value/portion_unit) so an old order keeps the portion it was
// ordered with even if the dish is edited later (same idea as item_name in
// migration 27). Old orders stay NULL: nothing reliable to backfill from.
// (Named "portion", not "quantity", because order_items.quantity is the line's count.)
exports.up = async function (knex) {
  await knex.schema.alterTable("items", (table) => {
    table.decimal("quantity_value", 8, 2).nullable();
    table.string("quantity_unit", 8).nullable();
  });
  await knex.schema.alterTable("order_items", (table) => {
    table.decimal("portion_value", 8, 2).nullable();
    table.string("portion_unit", 8).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("order_items", (table) => {
    table.dropColumn("portion_value");
    table.dropColumn("portion_unit");
  });
  await knex.schema.alterTable("items", (table) => {
    table.dropColumn("quantity_value");
    table.dropColumn("quantity_unit");
  });
};
