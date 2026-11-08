// "Reached Restaurant" / "Reached Customer" (client request via the Rider app): the rider taps when they arrive, with GPS and the time,
// and a manual exception is allowed. Server clock only. Recorded once per order and kind (a repeat returns the stored values).
// reached_*_manual is true when the app says so, when there was no GPS, or when the GPS was farther than ARRIVAL_RADIUS_M from the place.
exports.up = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    for (const p of ["reached_restaurant", "reached_customer"]) {
      table.timestamp(`${p}_at`).nullable();
      table.decimal(`${p}_lat`, 10, 7).nullable();
      table.decimal(`${p}_lng`, 10, 7).nullable();
      table.decimal(`${p}_accuracy_m`, 8, 1).nullable();
      table.integer(`${p}_distance_m`).unsigned().nullable();
      table.boolean(`${p}_manual`).notNullable().defaultTo(false);
    }
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("orders", (table) => {
    for (const p of ["reached_restaurant", "reached_customer"]) {
      for (const c of ["at", "lat", "lng", "accuracy_m", "distance_m", "manual"]) table.dropColumn(`${p}_${c}`);
    }
  });
};
