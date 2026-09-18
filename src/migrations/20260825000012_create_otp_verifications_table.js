exports.up = function (knex) {
  return knex.schema.createTable("otp_verifications", (table) => {
    table.increments("id").primary();
    table.string("phone", 20).notNullable();
    table.string("otp_hash", 255).notNullable(); // never store raw OTP
    table.enu("purpose", ["login", "signup", "restaurant_login", "rider_login"]).notNullable().defaultTo("login");
    table.integer("attempt_count").unsigned().notNullable().defaultTo(0);
    table.timestamp("expires_at").notNullable();
    table.boolean("verified").notNullable().defaultTo(false);
    table.timestamps(true, true);

    table.index(["phone", "purpose"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("otp_verifications");
};
