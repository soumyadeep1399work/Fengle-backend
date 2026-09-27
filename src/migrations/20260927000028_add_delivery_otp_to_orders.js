// Rapido/Swiggy-style delivery confirmation: the customer is shown this code
// and reads it to the rider in person; the rider must submit it correctly to
// mark the order delivered (see order.controller.js markDelivered). Nullable
// because orders placed before this migration have none — markDelivered
// treats a null code as "no check required" for those.
exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.string("delivery_otp", 4).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("delivery_otp");
  });
};
