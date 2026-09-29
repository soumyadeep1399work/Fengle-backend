// In-app agreement + live owner/rider selfie verification (client request,
// 2026-09-29), on top of the physical signed agreement. Applies to accounts
// onboarded from now on only — existing rows are backfilled here (accepted
// at their own created_at, at the version live when this migration runs) so
// they're never gated; only a row left NULL by a later insert is gated.
const CURRENT_AGREEMENT_VERSION = Number(process.env.CURRENT_AGREEMENT_VERSION) || 1;

exports.up = async function (knex) {
  for (const tableName of ["restaurants", "riders"]) {
    await knex.schema.alterTable(tableName, (table) => {
      table.timestamp("agreement_accepted_at").nullable();
      table.integer("agreement_version").unsigned().nullable();
      // Internal disk/S3 path — never a public URL like catalog photos, since
      // it's a person's face. Served only via the admin streaming endpoint.
      table.string("agreement_selfie_path").nullable();
    });
    await knex(tableName).update({
      agreement_accepted_at: knex.ref("created_at"),
      agreement_version: CURRENT_AGREEMENT_VERSION,
    });
  }
};

exports.down = async function (knex) {
  for (const tableName of ["restaurants", "riders"]) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropColumn("agreement_accepted_at");
      table.dropColumn("agreement_version");
      table.dropColumn("agreement_selfie_path");
    });
  }
};
