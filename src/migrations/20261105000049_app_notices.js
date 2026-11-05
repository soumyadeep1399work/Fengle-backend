// Popup notices for the Customer app (client request 2026-11-05): an admin posts an announcement (a new offer, a holiday closure...) and
// logged-in customers see it once as a popup. No live notice = no popup. `revision` goes up whenever the visible content is edited, so
// the app shows an edited notice again to people who already dismissed the old wording.
exports.up = async function (knex) {
  await knex.schema.createTable("app_notices", (table) => {
    table.increments("id").primary();
    table.string("title", 80).notNullable();
    table.string("body", 500).nullable();
    table.string("image_url", 500).nullable();
    table.string("cta_label", 30).nullable(); // optional button text
    table.enu("cta_target", ["none", "coupons"]).notNullable().defaultTo("none"); // what the optional button opens in the app
    table.datetime("starts_at").nullable(); // both null = live as long as it is active
    table.datetime("ends_at").nullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.integer("revision").notNullable().defaultTo(1);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.raw("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"));
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("app_notices");
};
