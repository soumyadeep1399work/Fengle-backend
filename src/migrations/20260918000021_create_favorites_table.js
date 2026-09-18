exports.up = function (knex) {
  return knex.schema.createTable("favorites", (table) => {
    table.increments("id").primary();
    table.integer("customer_id").unsigned().notNullable()
      .references("id").inTable("users").onDelete("CASCADE");
    table.integer("item_id").unsigned().notNullable()
      .references("id").inTable("items").onDelete("CASCADE");
    table.timestamps(true, true);

    table.unique(["customer_id", "item_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("favorites");
};
