// Cancellation is allowed only "before the restaurant begins preparation" — this
// needs an explicit trigger, not a timer guess (see CLAUDE.md). `accepted` alone
// isn't specific enough: a restaurant can accept an order and still not have
// started cooking yet. This column is set by a dedicated "Start Preparing"
// action in the Restaurant Panel.
exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.timestamp("preparation_started_at").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("preparation_started_at");
  });
};
