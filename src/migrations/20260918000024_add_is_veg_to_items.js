// Needed for GET /items/search?veg= and the Home/Category "Veg only" toggle.
exports.up = function (knex) {
  return knex.schema.alterTable("items", (table) => {
    table.boolean("is_veg").notNullable().defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("items", (table) => {
    table.dropColumn("is_veg");
  });
};
