// Single shared ledger for both customer wallets (refunds/credits) and rider wallets (COD reconciliation).
// See Section 6.2 — this is the source of truth; users.wallet_balance / riders.wallet_balance are
// denormalized running totals kept in sync with the latest row here for fast reads.
exports.up = function (knex) {
  return knex.schema.createTable("wallet_ledger", (table) => {
    table.increments("id").primary();
    table.enu("owner_type", ["customer", "rider"]).notNullable();
    table.integer("owner_id").unsigned().notNullable(); // FK to users.id or riders.id depending on owner_type

    table.enu("entry_type", ["credit", "debit"]).notNullable();
    table.decimal("amount", 12, 2).notNullable();
    table.decimal("balance_after", 12, 2).notNullable();

    table.enu("reason", [
      "cod_collected",       // rider debit: liability logged when cash collected
      "settlement_payout",   // rider credit: earnings paid out at settlement
      "settlement_deduction",// rider debit: COD liability netted against earnings
      "order_refund",        // customer credit: dropped item / cancellation refund
      "manual_adjustment",   // admin-initiated correction
    ]).notNullable();

    table.integer("related_order_id").unsigned().nullable()
      .references("id").inTable("orders").onDelete("SET NULL");

    table.text("notes").nullable();
    table.timestamps(true, true);

    table.index(["owner_type", "owner_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("wallet_ledger");
};
