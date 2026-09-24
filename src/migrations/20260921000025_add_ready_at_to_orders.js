// Restaurant "Mark ready" (food is ready for the rider to collect). Purely a
// signal for the rider side — it does not change `status` and pickup is not
// blocked on it.
exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.timestamp("ready_at").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("ready_at");
  });
};
