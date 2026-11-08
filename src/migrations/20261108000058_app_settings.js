// A small key/value store for settings an admin edits in the panel (first use: the support contact shown in the Restaurant and Rider
// apps). `value` is JSON text. A row's existence means "an admin has set this": until then the server's env values are what apps see.
exports.up = async function (knex) {
  await knex.schema.createTable("app_settings", (table) => {
    table.string("key", 64).primary();
    table.text("value").notNullable();
    table.integer("updated_by_admin_id").unsigned().nullable().references("id").inTable("admins").onDelete("SET NULL");
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("app_settings");
};
