// Saved addresses for customers (Addresses screen in the Customer App design —
// label, default flag, edit/delete). Orders intentionally do NOT reference this
// table by FK: placeOrder snapshots delivery_lat/delivery_lng/delivery_address
// directly onto the order row, so deleting a saved address never touches order
// history.
exports.up = function (knex) {
  return knex.schema.createTable("addresses", (table) => {
    table.increments("id").primary();
    table.integer("customer_id").unsigned().notNullable()
      .references("id").inTable("users").onDelete("CASCADE");
    table.string("label", 50).notNullable(); // "Home" | "Work" | freeform
    table.string("address_line", 255).notNullable();
    table.decimal("lat", 10, 7).notNullable();
    table.decimal("lng", 10, 7).notNullable();
    table.boolean("is_default").notNullable().defaultTo(false);
    table.timestamps(true, true);

    table.index(["customer_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("addresses");
};
