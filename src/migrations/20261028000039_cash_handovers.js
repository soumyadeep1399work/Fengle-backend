// COD cash handovers (client checklist item 5, 2026-10-28): when a rider hands the COD cash
// they collected to Fengle, an admin records it. It writes a wallet_ledger CREDIT with the new
// reason `cash_handover`, which reduces the rider's outstanding COD liability (the rider's
// negative wallet balance). cash_handovers keeps the human details (when it was received, a
// reference, notes, who recorded it) and points at the ledger row.
exports.up = async function (knex) {
  // Add the new ledger reason without dropping any value an earlier migration already added.
  const [rows] = await knex.raw("SHOW COLUMNS FROM wallet_ledger LIKE 'reason'");
  const current = rows[0].Type.match(/^enum\((.*)\)$/i)[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  if (!current.includes("cash_handover")) {
    const list = [...current, "cash_handover"].map((v) => `'${v}'`).join(",");
    await knex.raw(`ALTER TABLE wallet_ledger MODIFY reason ENUM(${list}) NOT NULL`);
  }

  await knex.schema.createTable("cash_handovers", (table) => {
    table.increments("id").primary();
    table.integer("rider_id").unsigned().notNullable().references("id").inTable("riders");
    table.decimal("amount", 12, 2).notNullable();
    table.timestamp("received_at").notNullable().defaultTo(knex.fn.now());
    table.string("reference", 100).nullable(); // e.g. a receipt number; unique per rider so a double-submit can't record the same handover twice
    table.text("notes").nullable();
    table.integer("received_by_admin_id").unsigned().nullable();
    table.integer("ledger_entry_id").unsigned().nullable(); // the wallet_ledger credit this created
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["rider_id", "reference"]);
    table.index(["rider_id", "received_at"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("cash_handovers");
  await knex("wallet_ledger").where({ reason: "cash_handover" }).delete();
  const [rows] = await knex.raw("SHOW COLUMNS FROM wallet_ledger LIKE 'reason'");
  const current = rows[0].Type.match(/^enum\((.*)\)$/i)[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter((v) => v !== "cash_handover");
  await knex.raw(`ALTER TABLE wallet_ledger MODIFY reason ENUM(${current.map((v) => `'${v}'`).join(",")}) NOT NULL`);
};
