// Customer complaints with a reference number, resolved from the Admin panel (client checklist item 8, "Repair the Customer
// Support section"). `reference` is human-friendly ("FSP-000123") and derived from the id, so it is set right after the insert.
exports.up = async function (knex) {
  await knex.schema.createTable("support_tickets", (table) => {
    table.increments("id").primary();
    table.string("reference", 20).nullable().unique();
    table.integer("customer_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
    table.integer("order_id").unsigned().nullable().references("id").inTable("orders").onDelete("SET NULL");
    table.enu("category", ["order_issue", "missing_item", "payment_failed", "refund", "delivery_delay", "general"]).notNullable();
    table.text("message").notNullable();
    table.enu("status", ["open", "in_progress", "resolved"]).notNullable().defaultTo("open");
    table.text("resolution_note").nullable();
    table.integer("resolved_by").unsigned().nullable().references("id").inTable("admins").onDelete("SET NULL");
    table.timestamp("resolved_at").nullable();
    table.timestamps(true, true);
    table.index(["customer_id", "created_at"]);
    table.index(["status", "created_at"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("support_tickets");
};
