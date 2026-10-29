// Rider payout account (client request 2026-10-29): riders add their bank account (and optionally a UPI id) in the Rider app so
// admins can pay the weekly settlement. One CURRENT account per rider, plus an append-only history of every change.
//
// The account number is encrypted at rest (AES-256-GCM, key in BANK_DATA_KEY) and only its last 4 digits are stored in the clear,
// for masked display. The history stores last-4s only, never the full number.
exports.up = async function (knex) {
  await knex.schema.createTable("rider_bank_accounts", (table) => {
    table.increments("id").primary();
    table.integer("rider_id").unsigned().notNullable().unique().references("id").inTable("riders");
    table.string("account_holder_name", 100).notNullable();
    table.text("account_number_enc").notNullable(); // "iv.tag.ciphertext" (base64), AES-256-GCM
    table.string("account_number_last4", 4).notNullable();
    table.string("ifsc", 11).notNullable();
    table.string("bank_name", 100).nullable();
    table.string("upi_id", 320).nullable();
    table.timestamps(true, true);
  });

  await knex.schema.createTable("rider_bank_account_history", (table) => {
    table.increments("id").primary();
    table.integer("rider_id").unsigned().notNullable().references("id").inTable("riders");
    table.enu("action", ["create", "update"]).notNullable();
    table.string("changed_by", 20).notNullable().defaultTo("rider");
    table.string("before_holder", 100).nullable();
    table.string("before_last4", 4).nullable();
    table.string("before_ifsc", 11).nullable();
    table.string("before_upi", 320).nullable();
    table.string("after_holder", 100).nullable();
    table.string("after_last4", 4).nullable();
    table.string("after_ifsc", 11).nullable();
    table.string("after_upi", 320).nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["rider_id", "created_at"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("rider_bank_account_history");
  await knex.schema.dropTableIfExists("rider_bank_accounts");
};
