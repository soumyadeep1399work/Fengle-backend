// Admin approve/deny of the in-app agreement selfie (2026-10-05). Until a
// partner's selfie is approved the API refuses everything except the
// onboarding endpoints (see requireAuth in middleware/auth.middleware.js).
//
// The column DEFAULT is 'approved' on purpose: every row that exists when this
// runs (seed/dev accounts, Play-review demo logins, everyone onboarded before
// today) stays fully working with no backfill, and a future insert path that
// forgets the column fails open instead of silently locking an account out.
// The two paths that onboard a NEW partner — the admin "onboard kitchen" flow
// and rider self-signup — set 'pending' explicitly.
exports.up = async function (knex) {
  for (const tableName of ["restaurants", "riders"]) {
    await knex.schema.alterTable(tableName, (table) => {
      table.enu("verification_status", ["pending", "approved", "denied"]).notNullable().defaultTo("approved");
      table.string("verification_denied_reason", 255).nullable();
      table.timestamp("verification_reviewed_at").nullable();
      table.integer("verification_reviewed_by_admin_id").unsigned().nullable();
    });
  }
};

exports.down = async function (knex) {
  for (const tableName of ["restaurants", "riders"]) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropColumn("verification_status");
      table.dropColumn("verification_denied_reason");
      table.dropColumn("verification_reviewed_at");
      table.dropColumn("verification_reviewed_by_admin_id");
    });
  }
};
