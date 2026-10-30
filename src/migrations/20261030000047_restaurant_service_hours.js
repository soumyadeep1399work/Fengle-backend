// Kitchen service hours (client request 2026-10-30): customers could order outside a kitchen's running time. One daily window per
// kitchen, same every day, in IST, set by an admin. Both NULL = always open (every existing kitchen, so nothing changes on deploy).
// closes_at earlier than opens_at is an overnight window. Per-weekday schedules are a later step.
exports.up = async function (knex) {
  await knex.schema.alterTable("restaurants", (table) => {
    table.time("opens_at").nullable();
    table.time("closes_at").nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("restaurants", (table) => {
    table.dropColumn("opens_at");
    table.dropColumn("closes_at");
  });
};
