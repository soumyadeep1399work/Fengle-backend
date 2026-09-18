exports.up = function (knex) {
  return knex.schema.createTable("users", (table) => {
    table.increments("id").primary();
    table.string("name", 120).nullable();
    table.string("phone", 20).notNullable().unique();
    table.string("email", 150).nullable().unique();
    table.string("password_hash", 255).nullable(); // optional password, OTP is default login
    table.decimal("wallet_balance", 12, 2).notNullable().defaultTo(0);
    table.decimal("last_known_lat", 10, 7).nullable();
    table.decimal("last_known_lng", 10, 7).nullable();
    table.enu("status", ["active", "blocked"]).notNullable().defaultTo("active");
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("users");
};
