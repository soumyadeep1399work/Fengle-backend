// Notification centre (client checklist item 7, 2026-10-29): super_admin-composed push campaigns to customers,
// sent now or scheduled, with a delivery report.
//   kind `promotion` respects each customer's "Offers & news" opt-out (notification_prefs.promotions);
//   kind `service` (outage, policy, safety notices) goes to every targeted customer regardless.
//   audience_type all | filtered (the same filters as GET /admin/customers) | phones (an explicit list).
// The row doubles as the audit trail: who sent what to how many, and how many pushes were accepted / failed.
exports.up = function (knex) {
  return knex.schema.createTable("notification_campaigns", (table) => {
    table.increments("id").primary();
    table.string("title", 100).notNullable();
    table.string("body", 500).notNullable();
    table.enu("kind", ["promotion", "service"]).notNullable();
    table.enu("audience_type", ["all", "filtered", "phones"]).notNullable();
    table.text("audience_filters").nullable(); // JSON text: the customer filters for audience_type=filtered
    table.text("audience_phones").nullable();  // JSON text: the phone list for audience_type=phones
    table.timestamp("scheduled_at").nullable(); // when it was/will be sent; for "send now" this is the creation time
    table.enu("status", ["scheduled", "sending", "sent", "cancelled", "failed"]).notNullable().defaultTo("scheduled");
    table.integer("targeted_customers").unsigned().nullable(); // filled in when the send starts
    table.integer("targeted_devices").unsigned().nullable();
    table.integer("sent_count").unsigned().notNullable().defaultTo(0);
    table.integer("failed_count").unsigned().notNullable().defaultTo(0);
    table.text("error").nullable();
    table.integer("created_by_admin_id").unsigned().nullable();
    table.timestamp("sent_at").nullable();
    table.timestamp("cancelled_at").nullable();
    table.timestamps(true, true);
    table.index(["status", "scheduled_at"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("notification_campaigns");
};
