exports.up = function (knex) {
  return knex.schema.createTable("restaurants", (table) => {
    table.increments("id").primary();
    table.string("name", 150).notNullable();
    table.string("owner_name", 120).nullable();
    table.string("phone", 20).notNullable();
    table.string("email", 150).nullable();
    table.string("password_hash", 255).nullable(); // restaurant panel login
    table.string("address", 255).notNullable();
    table.decimal("lat", 10, 7).notNullable();
    table.decimal("lng", 10, 7).notNullable();
    table.decimal("radius_km", 5, 2).notNullable().defaultTo(5.0); // admin-configurable
    table.decimal("commission_rate_percent", 5, 2).notNullable().defaultTo(15.0);
    table.enu("status", ["active", "inactive", "suspended"]).notNullable().defaultTo("active");
    table.enu("onboarded_by", ["admin"]).notNullable().defaultTo("admin"); // manual onboarding only
    table.timestamps(true, true);

    table.index(["lat", "lng"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("restaurants");
};
