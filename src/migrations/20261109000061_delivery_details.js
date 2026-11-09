// The customer's delivery details beyond the map address (client request via the Rider app): flat / building / floor, a landmark and
// delivery instructions as separate fields. Nullable: older customer apps keep merging that text into delivery_address and send none of these.
exports.up = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.string("delivery_building", 120).nullable();
    table.string("delivery_landmark", 120).nullable();
    table.string("delivery_instructions", 250).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("delivery_building");
    table.dropColumn("delivery_landmark");
    table.dropColumn("delivery_instructions");
  });
};
