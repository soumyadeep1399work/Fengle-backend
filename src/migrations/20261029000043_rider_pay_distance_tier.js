// Two-rate rider distance pay (client decision 2026-10-29): e.g. Rs 10/km for the first 5 km, a different
// per-km rate beyond that. Both columns NULL (the default for every existing row) = the old single-rate
// formula, so nothing changes until a super_admin saves a config with a tier. rider_pay_config stays append-only.
exports.up = function (knex) {
  return knex.schema.alterTable("rider_pay_config", (table) => {
    table.decimal("tier_km", 10, 2).nullable();
    table.decimal("per_km_rate_after_tier", 10, 2).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("rider_pay_config", (table) => {
    table.dropColumn("tier_km");
    table.dropColumn("per_km_rate_after_tier");
  });
};
