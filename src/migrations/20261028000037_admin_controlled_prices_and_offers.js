// Prices are set by Fengle admins only (client decision 2026-10-28), plus per-dish offers.
//
// items.awaiting_price: a dish a kitchen created has no price yet. It stays hidden
//   (is_active = false) until an admin sets the price. price is NOT NULL, so such a
//   row stores 0.00 and every read presents it as null.
// items.offer_price / offer_ends_at: an admin-set discounted price for one dish. It is
//   in force while offer_price is set, below price, and offer_ends_at is null or future.
//   Cart quote / order placement charge it, so item_total, GST and commission all follow
//   what the customer actually pays.
// order_items.list_price: the dish's normal price at order time (unit_price is what was
//   charged), so a discounted line can still show the strike-through later. Old rows: NULL.
exports.up = async function (knex) {
  await knex.schema.alterTable("items", (table) => {
    table.boolean("awaiting_price").notNullable().defaultTo(false);
    table.decimal("offer_price", 10, 2).nullable();
    table.timestamp("offer_ends_at").nullable();
  });
  await knex.schema.alterTable("order_items", (table) => {
    table.decimal("list_price", 10, 2).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("order_items", (table) => {
    table.dropColumn("list_price");
  });
  await knex.schema.alterTable("items", (table) => {
    table.dropColumn("awaiting_price");
    table.dropColumn("offer_price");
    table.dropColumn("offer_ends_at");
  });
};
