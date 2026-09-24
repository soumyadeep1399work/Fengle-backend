// Kitchens can create categories without admin approval (2026-09-21), so
// duplicates are prevented at the source: name_normalized is the canonical key
// from utils/categoryName.js, unique-indexed as a race-safe backstop (the API
// checks first and returns friendly 409s). created_by_restaurant_id lets the
// future Admin Panel see who made a category before renaming/merging it.
const { normalizeCategoryName } = require("../utils/categoryName");

exports.up = async function (knex) {
  await knex.schema.alterTable("categories", (table) => {
    table.string("name_normalized", 80).nullable().unique();
    table.integer("created_by_restaurant_id").unsigned().nullable()
      .references("id").inTable("restaurants").onDelete("SET NULL");
  });

  // Backfill existing (admin/seed) categories. If two existing names collapse to
  // the same key the second stays NULL rather than failing the migration — the
  // API still detects duplicates by re-normalizing names, so NULL is safe.
  const rows = await knex("categories").select("id", "name");
  for (const row of rows) {
    const key = normalizeCategoryName(row.name);
    if (!key) continue;
    try {
      await knex("categories").where({ id: row.id }).update({ name_normalized: key });
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY") throw err;
      console.warn(`[migration] category #${row.id} "${row.name}" duplicates another category's key "${key}" — left unkeyed`);
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable("categories", (table) => {
    table.dropForeign("created_by_restaurant_id");
    table.dropColumn("created_by_restaurant_id");
    table.dropColumn("name_normalized");
  });
};
