// Customer app T&C popup (client request, 2026-09-30) — a lightweight, one-time
// checkbox acceptance, unrelated to the restaurant/rider agreement+selfie
// feature (see 20260929000030). No selfie here, just a timestamp + version.
// Applies to accounts created from now on only — existing customers are
// backfilled as already-accepted in this same migration.
const { CUSTOMER_TERMS_VERSION } = require("../utils/customerTerms");

exports.up = async function (knex) {
  await knex.schema.alterTable("users", (table) => {
    table.timestamp("agreement_accepted_at").nullable();
    table.integer("agreement_version").unsigned().nullable();
  });
  await knex("users").update({
    agreement_accepted_at: knex.ref("created_at"),
    agreement_version: CUSTOMER_TERMS_VERSION,
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.dropColumn("agreement_accepted_at");
    table.dropColumn("agreement_version");
  });
};
