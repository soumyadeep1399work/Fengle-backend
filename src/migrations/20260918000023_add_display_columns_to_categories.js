// Powers the Home/Category screens' "35-45 min - min ₹50" line. min_order
// is nullable and falls back to the global MIN_ORDER_VALUE constant in
// order.controller.js when unset — most categories won't need an override.
exports.up = function (knex) {
  return knex.schema.alterTable("categories", (table) => {
    table.integer("prep_time_min_minutes").unsigned().nullable();
    table.integer("prep_time_max_minutes").unsigned().nullable();
    table.decimal("min_order_override", 10, 2).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("categories", (table) => {
    table.dropColumn("prep_time_min_minutes");
    table.dropColumn("prep_time_max_minutes");
    table.dropColumn("min_order_override");
  });
};
