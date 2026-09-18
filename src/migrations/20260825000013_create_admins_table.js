exports.up = function (knex) {
  return knex.schema.createTable("admins", (table) => {
    table.increments("id").primary();
    table.string("name", 120).notNullable();
    table.string("email", 150).notNullable().unique();
    table.string("password_hash", 255).notNullable();
    table.enu("role", ["super_admin", "ops"]).notNullable().defaultTo("ops");
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("admins");
};
