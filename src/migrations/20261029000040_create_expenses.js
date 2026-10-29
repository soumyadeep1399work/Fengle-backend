// Business expenses entered by a super_admin (client checklist item 9, 2026-10-29), so the
// profit & loss report can subtract what Fengle spends outside of orders.
exports.up = function (knex) {
  return knex.schema.createTable("expenses", (table) => {
    table.increments("id").primary();
    table.date("expense_date").notNullable();
    table.enu("category", ["marketing", "operating", "salaries", "other"]).notNullable();
    table.decimal("amount", 12, 2).notNullable();
    table.text("notes").nullable();
    table.integer("created_by_admin_id").unsigned().nullable();
    table.timestamps(true, true);
    table.index(["expense_date"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("expenses");
};
