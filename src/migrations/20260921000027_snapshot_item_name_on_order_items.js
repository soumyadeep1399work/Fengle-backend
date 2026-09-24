// Restaurants can now rename items (PATCH /items/:id) and the item is shared,
// so past orders must keep the name they were placed under — order history
// otherwise silently rewrites itself. order_items already snapshots
// unit_price/subtotal; this adds the name. Reads use
// COALESCE(order_items.item_name, items.name) so any row that somehow lacks a
// snapshot still shows something.
exports.up = async function (knex) {
  await knex.schema.alterTable("order_items", (table) => {
    table.string("item_name", 150).nullable();
  });
  // Backfill from the current item name — the best available for orders placed
  // before this migration (a rename that happened earlier can't be recovered).
  await knex.raw("UPDATE order_items oi JOIN items i ON i.id = oi.item_id SET oi.item_name = i.name WHERE oi.item_name IS NULL");
};

exports.down = function (knex) {
  return knex.schema.alterTable("order_items", (table) => {
    table.dropColumn("item_name");
  });
};
