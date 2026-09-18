// Items belong to a category, not to a specific restaurant (confirmed: no restaurant-exclusive items).
// Both Admin and Restaurant can create items (confirmed).
exports.up = function (knex) {
  return knex.schema.createTable("items", (table) => {
    table.increments("id").primary();
    table.integer("category_id").unsigned().notNullable()
      .references("id").inTable("categories").onDelete("CASCADE");
    table.string("name", 150).notNullable();
    table.string("description", 255).nullable();
    table.decimal("price", 10, 2).notNullable();
    table.string("image_url", 500).nullable();
    table.enu("created_by_type", ["admin", "restaurant"]).notNullable();
    table.integer("created_by_restaurant_id").unsigned().nullable()
      .references("id").inTable("restaurants").onDelete("SET NULL");
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamps(true, true);

    table.index(["category_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("items");
};
