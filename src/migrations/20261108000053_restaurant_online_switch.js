// A kitchen's own Online / Offline switch (client request via the Restaurant app): for when it closes early, runs out of staff or
// ingredients, or is overloaded. It works on top of the admin-set daily window (mig 47): a kitchen takes orders only when it is
// online AND inside its hours. Every existing kitchen stays online. restaurant_availability_history records each real change.
exports.up = async function (knex) {
  await knex.schema.alterTable("restaurants", (table) => {
    table.boolean("is_online").notNullable().defaultTo(true);
  });
  await knex.schema.createTable("restaurant_availability_history", (table) => {
    table.increments("id").primary();
    table.integer("restaurant_id").unsigned().notNullable().references("id").inTable("restaurants");
    table.boolean("is_online").notNullable(); // the state it changed TO
    table.string("changed_by", 20).notNullable().defaultTo("restaurant"); // restaurant | admin
    table.integer("admin_id").unsigned().nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["restaurant_id", "created_at"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("restaurant_availability_history");
  await knex.schema.alterTable("restaurants", (table) => {
    table.dropColumn("is_online");
  });
};
