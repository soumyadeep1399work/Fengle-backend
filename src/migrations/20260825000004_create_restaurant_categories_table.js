// A restaurant can serve multiple categories — this is what makes clubbed orders possible.
exports.up = function (knex) {
  return knex.schema.createTable("restaurant_categories", (table) => {
    table.increments("id").primary();
    table.integer("restaurant_id").unsigned().notNullable()
      .references("id").inTable("restaurants").onDelete("CASCADE");
    table.integer("category_id").unsigned().notNullable()
      .references("id").inTable("categories").onDelete("CASCADE");
    table.timestamps(true, true);

    table.unique(["restaurant_id", "category_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("restaurant_categories");
};
