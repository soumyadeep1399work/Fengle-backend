// category_id is stored redundantly here (not just via item->category) so clubbed orders
// can be reported on per-category even though the customer sees a single bill (Section 4).
exports.up = function (knex) {
  return knex.schema.createTable("order_items", (table) => {
    table.increments("id").primary();
    table.integer("order_id").unsigned().notNullable()
      .references("id").inTable("orders").onDelete("CASCADE");
    table.integer("item_id").unsigned().notNullable()
      .references("id").inTable("items").onDelete("RESTRICT");
    table.integer("category_id").unsigned().notNullable()
      .references("id").inTable("categories").onDelete("RESTRICT");
    table.integer("quantity").unsigned().notNullable().defaultTo(1);
    table.decimal("unit_price", 10, 2).notNullable(); // snapshot at order time, price may change later
    table.decimal("subtotal", 10, 2).notNullable();
    table.enu("status", ["confirmed", "dropped_unavailable"]).notNullable().defaultTo("confirmed"); // Section 4 partial-unavailability handling
    table.timestamps(true, true);

    table.index(["order_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("order_items");
};
