exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.timestamp("rider_settled_at").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("rider_settled_at");
  });
};
