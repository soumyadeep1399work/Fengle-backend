// Partner KYC / licence documents (2026-10-28). Restaurants upload the owner's
// Aadhaar, FSSAI licence and trade licence; riders upload Aadhaar and, optionally,
// a driving licence — through the partner web portal (partner.fengle.in) — and an
// admin approves or rejects each one.
//
// Every upload is a new row (history is kept); a partner's "current" document of a
// type is its latest row, and the one that counts for blocking is its latest
// *approved* row — so a renewed licence waiting for review doesn't interrupt a
// partner whose previous one is still approved and in date.
//
// documents_valid_until on restaurants/riders is a denormalized cache of that rule,
// recomputed on every upload and review (services/partnerDocuments.service.js):
// the earliest expiry among the approved required documents ('9999-12-31' when none
// of them expire), or NULL while any required document is missing. Routing and
// rider assignment compare it to today's date, so an expired licence blocks on its
// own with no scheduled job. Enforcement is behind PARTNER_DOCUMENTS_ENFORCED.
exports.up = async function (knex) {
  await knex.schema.createTable("partner_documents", (table) => {
    table.increments("id").primary();
    table.enu("owner_type", ["restaurant", "rider"]).notNullable();
    table.integer("owner_id").unsigned().notNullable(); // restaurants.id or riders.id, by owner_type
    table.enu("doc_type", ["aadhaar", "fssai", "trade_license", "driving_license"]).notNullable();
    // Internal storage key (private disk path or private-bucket key) — never a URL, never returned by the API.
    table.string("storage_path", 255).notNullable();
    table.string("content_type", 60).notNullable();
    table.integer("file_size").unsigned().notNullable();
    table.string("doc_number", 40).nullable();
    table.date("expiry_date").nullable();
    table.enu("status", ["pending", "approved", "rejected"]).notNullable().defaultTo("pending");
    table.string("rejection_reason", 255).nullable();
    table.integer("reviewed_by_admin_id").unsigned().nullable();
    table.timestamp("reviewed_at").nullable();
    table.timestamps(true, true);

    table.index(["owner_type", "owner_id", "doc_type"]);
    table.index(["status"]);
  });

  for (const tableName of ["restaurants", "riders"]) {
    await knex.schema.alterTable(tableName, (table) => {
      table.date("documents_valid_until").nullable();
    });
  }
};

exports.down = async function (knex) {
  for (const tableName of ["restaurants", "riders"]) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropColumn("documents_valid_until");
    });
  }
  await knex.schema.dropTableIfExists("partner_documents");
};
