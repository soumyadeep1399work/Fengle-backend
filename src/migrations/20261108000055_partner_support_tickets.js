// Partner support (client request via the Restaurant app): kitchens (and later riders) raise a support ticket and keep a REPLY THREAD
// with Fengle, with screenshots. One set of tables for both partner types (partner_type + partner_id, polymorphic like wallet_ledger,
// so no foreign key on partner_id). The customer tickets (support_tickets, single message) are separate. Attachments are stored in
// the PRIVATE bucket / directory like partner documents; only an authenticated endpoint reads them back, never a public URL.
exports.up = async function (knex) {
  await knex.schema.createTable("partner_support_tickets", (table) => {
    table.increments("id").primary();
    table.string("reference", 20).nullable().unique(); // "FPS-000123", derived from the id
    table.enu("partner_type", ["restaurant", "rider"]).notNullable();
    table.integer("partner_id").unsigned().notNullable();
    table.integer("order_id").unsigned().nullable().references("id").inTable("orders").onDelete("SET NULL");
    table.enu("category", ["not_receiving_orders", "login_problem", "payment_settlement", "order_cancelled", "technical", "menu_or_prices", "documents", "other"]).notNullable();
    table.enu("status", ["open", "in_progress", "resolved"]).notNullable().defaultTo("open");
    table.enu("last_message_by", ["partner", "admin"]).notNullable().defaultTo("partner");
    table.timestamp("last_message_at").notNullable().defaultTo(knex.fn.now());
    table.integer("resolved_by").unsigned().nullable().references("id").inTable("admins").onDelete("SET NULL");
    table.timestamp("resolved_at").nullable();
    table.timestamps(true, true);
    table.index(["partner_type", "partner_id", "created_at"]);
    table.index(["status", "created_at"]);
  });

  await knex.schema.createTable("partner_support_messages", (table) => {
    table.increments("id").primary();
    table.integer("ticket_id").unsigned().notNullable().references("id").inTable("partner_support_tickets").onDelete("CASCADE");
    table.enu("author", ["partner", "admin"]).notNullable();
    table.integer("admin_id").unsigned().nullable().references("id").inTable("admins").onDelete("SET NULL");
    table.text("body").notNullable(); // the first message of a ticket is the complaint itself
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["ticket_id", "created_at"]);
  });

  await knex.schema.createTable("partner_support_attachments", (table) => {
    table.increments("id").primary();
    table.integer("message_id").unsigned().notNullable().references("id").inTable("partner_support_messages").onDelete("CASCADE");
    table.string("name", 120).notNullable();
    table.string("content_type", 50).notNullable();
    table.integer("size").unsigned().notNullable();
    table.string("storage_path", 255).notNullable(); // private bucket key / bare file name; never sent to a client
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["message_id"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("partner_support_attachments");
  await knex.schema.dropTableIfExists("partner_support_messages");
  await knex.schema.dropTableIfExists("partner_support_tickets");
};
