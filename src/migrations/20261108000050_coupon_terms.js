// Admin-written terms & conditions for a coupon (Customer app Offers tab, "Terms & conditions" toggle). One term per line,
// newline-separated; NULL = none (the app then shows only the lines it derives itself: minimum order, discount cap, validity).
exports.up = async function (knex) {
  await knex.schema.alterTable("coupons", (table) => {
    table.text("terms").nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("coupons", (table) => {
    table.dropColumn("terms");
  });
};
