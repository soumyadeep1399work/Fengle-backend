// Intro slides of the Customer app, managed by an admin (client request 2026-11-05): the three pictures + texts were bundled in the
// app. Empty table = the app shows its built-in slides, so nothing changes until an admin adds some.
exports.up = async function (knex) {
  await knex.schema.createTable("onboarding_slides", (table) => {
    table.increments("id").primary();
    table.string("image_url", 500).notNullable();
    table.string("headline", 80).notNullable();
    table.string("body", 200).nullable();
    table.integer("sort_order").notNullable().defaultTo(0);
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.raw("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"));
    table.index(["is_active", "sort_order"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("onboarding_slides");
};
