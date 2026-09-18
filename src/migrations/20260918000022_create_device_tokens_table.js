// Generic across owner types (customer now; restaurant/rider panels will
// register devices here too once their push flows are built) — same
// owner_type/owner_id polymorphic shape as wallet_ledger.
exports.up = function (knex) {
  return knex.schema.createTable("device_tokens", (table) => {
    table.increments("id").primary();
    table.enu("owner_type", ["customer", "restaurant", "rider"]).notNullable();
    table.integer("owner_id").unsigned().notNullable();
    table.string("token", 255).notNullable();
    table.enu("platform", ["android", "ios"]).notNullable();
    table.timestamps(true, true);

    table.unique(["owner_type", "owner_id", "token"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("device_tokens");
};
