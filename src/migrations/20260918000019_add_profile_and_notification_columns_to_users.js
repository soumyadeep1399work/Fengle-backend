// Backs GET/PATCH /profile/me, PATCH /profile/preferences, and
// POST /notifications/register-device + PATCH /notifications/settings.
exports.up = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.string("photo_url", 500).nullable();
    table.boolean("veg_only").notNullable().defaultTo(false);
    table.json("notification_prefs").nullable(); // { order_updates: bool, promotions: bool } — null = defaults
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.dropColumn("photo_url");
    table.dropColumn("veg_only");
    table.dropColumn("notification_prefs");
  });
};
