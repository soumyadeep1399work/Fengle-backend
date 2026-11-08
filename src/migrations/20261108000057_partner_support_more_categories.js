// Rider support (client item): the Rider app's complaint types include "a problem with a particular order" and "a general complaint",
// which the kitchen categories (migration 55) don't have. Added for every partner type to keep one list.
const BASE = ["not_receiving_orders", "login_problem", "payment_settlement", "order_cancelled", "technical", "menu_or_prices", "documents", "other"];
const enumSql = (values) => values.map((v) => `'${v}'`).join(",");

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE partner_support_tickets MODIFY category ENUM(${enumSql([...BASE, "order_issue", "complaint"])}) NOT NULL`);
};

exports.down = async function (knex) {
  await knex("partner_support_tickets").whereIn("category", ["order_issue", "complaint"]).update({ category: "other" });
  await knex.raw(`ALTER TABLE partner_support_tickets MODIFY category ENUM(${enumSql(BASE)}) NOT NULL`);
};
