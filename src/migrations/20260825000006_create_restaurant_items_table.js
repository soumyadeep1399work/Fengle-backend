// Tracks which items a given restaurant currently has in stock.
// This is what "location-dependent catalog visibility" and the out-of-stock cascade logic query against.
exports.up = function (knex) {
  return knex.schema.createTable("restaurant_items", (table) => {
    table.increments("id").primary();
    table.integer("restaurant_id").unsigned().notNullable()
      .references("id").inTable("restaurants").onDelete("CASCADE");
    table.integer("item_id").unsigned().notNullable()
      .references("id").inTable("items").onDelete("CASCADE");
    table.boolean("is_available").notNullable().defaultTo(true); // restaurant's stock toggle
    table.timestamps(true, true);

    table.unique(["restaurant_id", "item_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("restaurant_items");
};
