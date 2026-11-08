// New-order alarm for kitchens (client request via the Restaurant app): the kitchen's phone rings until it acknowledges, with a
// reminder if nobody responds, and we record when the kitchen was notified and when it reacted (server clock only), so ops can see
// how long kitchens take. All reset when the order is re-routed to another kitchen.
exports.up = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.timestamp("kitchen_notified_at").nullable(); // first push for the current kitchen
    table.timestamp("kitchen_acknowledged_at").nullable();
    table.string("kitchen_acknowledged_by", 10).nullable(); // 'alert' (Stop alarm) | 'accept' | 'reject'
    table.integer("kitchen_reminders_sent").unsigned().notNullable().defaultTo(0);
    table.timestamp("kitchen_last_reminder_at").nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("kitchen_notified_at");
    table.dropColumn("kitchen_acknowledged_at");
    table.dropColumn("kitchen_acknowledged_by");
    table.dropColumn("kitchen_reminders_sent");
    table.dropColumn("kitchen_last_reminder_at");
  });
};
