// GST invoicing (Phase 1 scope, CLAUDE.md) needs CGST/SGST broken out separately
// from grand_total, not just folded in — the invoice screen shows them as
// distinct line items. grand_total = item_total + delivery_fee + cgst_amount + sgst_amount.
exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.decimal("cgst_amount", 10, 2).notNullable().defaultTo(0);
    table.decimal("sgst_amount", 10, 2).notNullable().defaultTo(0);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("cgst_amount");
    table.dropColumn("sgst_amount");
  });
};
