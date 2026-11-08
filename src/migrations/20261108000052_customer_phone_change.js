// A customer can change the phone number they log in with (client checklist: "change name, mobile number and email").
// The new number is proved with an OTP, so otp_verifications gets a 'phone_change' purpose and an owner_id (the customer asking),
// which stops one customer's code being used to claim a number another customer asked for. phone_change_history is the old -> new
// trace for support.
const PURPOSES = ["login", "signup", "restaurant_login", "rider_login"];

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE otp_verifications MODIFY purpose ENUM(${[...PURPOSES, "phone_change"].map((p) => `'${p}'`).join(",")}) NOT NULL DEFAULT 'login'`);
  await knex.schema.alterTable("otp_verifications", (table) => {
    table.integer("owner_id").unsigned().nullable(); // the customer a phone_change code was issued to; null for logins
  });
  await knex.schema.createTable("phone_change_history", (table) => {
    table.increments("id").primary();
    table.integer("customer_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
    table.string("old_phone", 20).notNullable();
    table.string("new_phone", 20).notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["customer_id", "created_at"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("phone_change_history");
  await knex.schema.alterTable("otp_verifications", (table) => {
    table.dropColumn("owner_id");
  });
  await knex("otp_verifications").where({ purpose: "phone_change" }).delete();
  await knex.raw(`ALTER TABLE otp_verifications MODIFY purpose ENUM(${PURPOSES.map((p) => `'${p}'`).join(",")}) NOT NULL DEFAULT 'login'`);
};
