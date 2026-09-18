exports.up = function (knex) {
  return knex.schema.createTable("riders", (table) => {
    table.increments("id").primary();
    table.string("name", 120).nullable();
    table.string("phone", 20).notNullable().unique();
    table.string("password_hash", 255).nullable(); // rider panel login
    table.string("vehicle_type", 50).nullable();
    table.string("vehicle_number", 30).nullable();
    table.decimal("wallet_balance", 12, 2).notNullable().defaultTo(0); // net of COD liability vs commission earned
    table.decimal("last_known_lat", 10, 7).nullable();
    table.decimal("last_known_lng", 10, 7).nullable();
    table.enu("status", ["active", "inactive", "suspended"]).notNullable().defaultTo("active");
    table.enu("onboarded_via", ["self_serve"]).notNullable().defaultTo("self_serve"); // confirmed: self-serve sign-up
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("riders");
};
