// Ratings live on the order row (one rider + one restaurant rating per
// order, matching GET /orders/:id's requested shape) rather than a separate
// ratings table — there's exactly one of each per order, never many.
// restaurant_rating_skipped lets a customer dismiss the post-delivery
// rating prompt without rating, while still leaving it rateable later; the
// server-side "must resolve before placing another order" gate (see
// order.controller.js) checks restaurant_rating IS NULL AND
// restaurant_rating_skipped = false.
exports.up = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.tinyint("rider_rating").unsigned().nullable();
    table.text("rider_rating_comment").nullable();
    table.tinyint("restaurant_rating").unsigned().nullable();
    table.text("restaurant_rating_comment").nullable();
    table.boolean("restaurant_rating_skipped").notNullable().defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("orders", (table) => {
    table.dropColumn("rider_rating");
    table.dropColumn("rider_rating_comment");
    table.dropColumn("restaurant_rating");
    table.dropColumn("restaurant_rating_comment");
    table.dropColumn("restaurant_rating_skipped");
  });
};
