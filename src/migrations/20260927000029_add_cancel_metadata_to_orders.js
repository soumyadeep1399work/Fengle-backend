// Admin Panel cancellation (POST /admin/orders/:id/cancel) needs to record
// why and by whom — customer/restaurant self-cancels don't set these, only
// the admin path does, so a null cancelled_by means "not an admin cancel".
exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.text("cancel_reason").nullable();
    table.enu("cancelled_by", ["customer", "restaurant", "admin", "system"]).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("cancel_reason");
    table.dropColumn("cancelled_by");
  });
};
