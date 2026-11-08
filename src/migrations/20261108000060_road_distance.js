// ONE road distance per order (client decision via the Rider app): kitchen -> drop-off from the Google Routes API, used for the rider alert,
// rider pay AND the customer fee, so all three agree. Kitchen matching and the catalog radius stay straight-line (a service-area rule).
//
// orders.route_*: the distance stored at placement (and recomputed when the kitchen changes). route_source says how it was measured:
//   road      - the Google Routes API answered
//   estimate  - the API failed, so straight line x ROUTE_FALLBACK_FACTOR (never blocks an order)
//   straight  - no GOOGLE_ROUTES_API_KEY is configured: the old straight-line distance, so nothing changes until the key is set
//
// route_cache: origin/destination rounded to 5 decimals (~1 m), so a cart quote and the order placed after it get the SAME number and a repeat
// address costs nothing. 'road' results are kept for good; an 'estimate' only until expires_at (a few minutes, so a quote and an order agree but a
// recovered API is tried again soon).
exports.up = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    table.decimal("route_distance_km", 8, 2).nullable();
    table.integer("route_duration_min").unsigned().nullable();
    table.enu("route_source", ["road", "estimate", "straight"]).nullable();
  });
  await knex.schema.createTable("route_cache", (table) => {
    table.increments("id").primary();
    table.decimal("origin_lat", 9, 5).notNullable();
    table.decimal("origin_lng", 9, 5).notNullable();
    table.decimal("dest_lat", 9, 5).notNullable();
    table.decimal("dest_lng", 9, 5).notNullable();
    table.integer("distance_m").unsigned().notNullable();
    table.integer("duration_s").unsigned().nullable();
    table.enu("source", ["road", "estimate"]).notNullable();
    table.timestamp("expires_at").nullable(); // null = keep (road); set for an estimate
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["origin_lat", "origin_lng", "dest_lat", "dest_lng"], "route_cache_pair_unique");
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("route_cache");
  await knex.schema.alterTable("orders", (table) => {
    table.dropColumn("route_distance_km");
    table.dropColumn("route_duration_min");
    table.dropColumn("route_source");
  });
};
