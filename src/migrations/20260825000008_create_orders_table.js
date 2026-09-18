exports.up = function (knex) {
  return knex.schema.createTable("orders", (table) => {
    table.increments("id").primary();
    table.integer("customer_id").unsigned().notNullable()
      .references("id").inTable("users").onDelete("RESTRICT");
    table.integer("restaurant_id").unsigned().nullable() // nullable until routing assigns one
      .references("id").inTable("restaurants").onDelete("RESTRICT");
    table.integer("rider_id").unsigned().nullable()
      .references("id").inTable("riders").onDelete("SET NULL");

    // Order status state machine — see Section 5 (delivery status) and Section 4 (clubbing/cascade)
    table.enu("status", [
      "placed",           // order created, routing in progress
      "accepted",         // restaurant accepted
      "picked_up",        // rider collected from restaurant
      "on_the_way",       // rider en route
      "delivered",
      "cancelled",
    ]).notNullable().defaultTo("placed");

    table.boolean("is_clubbed").notNullable().defaultTo(false); // same restaurant, 2 categories (Section 4)
    table.integer("cascade_attempts").unsigned().notNullable().defaultTo(0); // how many restaurants tried

    table.decimal("delivery_lat", 10, 7).notNullable();
    table.decimal("delivery_lng", 10, 7).notNullable();
    table.string("delivery_address", 255).notNullable();

    table.decimal("item_total", 10, 2).notNullable();
    table.decimal("delivery_fee", 10, 2).notNullable().defaultTo(0);
    table.decimal("commission_amount", 10, 2).notNullable().defaultTo(0); // platform's cut from restaurant
    table.decimal("grand_total", 10, 2).notNullable();

    table.enu("payment_method", ["upi", "card", "netbanking", "cod", "wallet"]).notNullable();
    table.enu("payment_status", ["pending", "paid", "failed", "refunded", "partially_refunded"]).notNullable().defaultTo("pending");
    table.string("razorpay_order_id", 100).nullable();
    table.string("razorpay_payment_id", 100).nullable();

    table.integer("eta_minutes").unsigned().nullable(); // one-time estimate set at pickup (Section 5)
    table.timestamp("picked_up_at").nullable();
    table.timestamp("delivered_at").nullable();
    table.timestamp("cancelled_at").nullable();

    table.timestamps(true, true);

    table.index(["customer_id"]);
    table.index(["restaurant_id"]);
    table.index(["rider_id"]);
    table.index(["status"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("orders");
};
