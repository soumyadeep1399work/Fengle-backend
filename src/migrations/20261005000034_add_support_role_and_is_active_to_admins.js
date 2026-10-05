// Admin Panel role-based access (2026-10-05): a third role, `support`, plus a
// per-account on/off switch and a last-login stamp. Existing admins keep their
// role and become active (column default), so nobody is locked out by this.
exports.up = async function (knex) {
  await knex.raw("ALTER TABLE admins MODIFY role ENUM('super_admin','ops','support') NOT NULL DEFAULT 'ops'");
  await knex.schema.alterTable("admins", (table) => {
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("last_login_at").nullable();
  });
};

exports.down = async function (knex) {
  await knex("admins").where({ role: "support" }).update({ role: "ops" });
  await knex.schema.alterTable("admins", (table) => {
    table.dropColumn("is_active");
    table.dropColumn("last_login_at");
  });
  await knex.raw("ALTER TABLE admins MODIFY role ENUM('super_admin','ops') NOT NULL DEFAULT 'ops'");
};
