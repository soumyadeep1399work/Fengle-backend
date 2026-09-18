// Historical commission rate changes, kept separate from restaurants.commission_rate_percent (current rate)
// so past orders' commission_amount can always be explained by the rate that applied at the time.
exports.up = function (knex) {
  return knex.schema.createTable("commission_config_history", (table) => {
    table.increments("id").primary();
    table.integer("restaurant_id").unsigned().notNullable()
      .references("id").inTable("restaurants").onDelete("CASCADE");
    table.decimal("rate_percent", 5, 2).notNullable();
    table.timestamp("effective_from").notNullable().defaultTo(knex.fn.now());
    table.integer("changed_by_admin_id").unsigned().nullable();
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("commission_config_history");
};
