// New-delivery alarm for riders (client request via the Rider app): the twin of the kitchen alarm (migration 54). The assigned rider's
// phone rings until the rider reacts, with a reminder if nobody responds, and we record when the rider was notified and when they
// reacted (server clock only). All reset whenever the order gets a different rider.
exports.up = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.timestamp("rider_notified_at").nullable(); // first push for the current rider
    table.timestamp("rider_acknowledged_at").nullable(); // "View assignment" on the alert, or picking the order up
    table.integer("rider_reminders_sent").unsigned().notNullable().defaultTo(0);
    table.timestamp("rider_last_reminder_at").nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("rider_notified_at");
    table.dropColumn("rider_acknowledged_at");
    table.dropColumn("rider_reminders_sent");
    table.dropColumn("rider_last_reminder_at");
  });
};
