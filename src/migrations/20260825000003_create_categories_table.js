exports.up = function (knex) {
  return knex.schema.createTable("categories", (table) => {
    table.increments("id").primary();
    table.string("name", 100).notNullable().unique(); // e.g. "South Indian", "Bengali"
    table.string("description", 255).nullable();
    table.string("image_url", 500).nullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("categories");
};
