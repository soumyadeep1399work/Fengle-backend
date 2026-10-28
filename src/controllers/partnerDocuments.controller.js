const db = require("../config/db");
const storage = require("../services/storage.service");
const docs = require("../services/partnerDocuments.service");

// ---------- Partner portal (restaurant / rider tokens) ----------

/** GET /partner/documents — what this partner must upload, what they have, and their standing. */
async function getMyDocuments(req, res) {
  const { id, type } = req.auth;
  const row = await db(docs.OWNER_TABLE[type]).where({ id }).select("name", "phone").first();
  const view = await docs.ownerView(type, id);
  res.json({ partner: { type, name: row ? row.name : null, phone: row ? row.phone : null }, ...view });
}

/** POST /partner/documents — multipart: file, doc_type, doc_number?, expiry_date? */
async function uploadMyDocument(req, res) {
  const result = await docs.upload(req.auth.type, req.auth.id, req.body || {}, req.file);
  res.status(result.status).json(result.body);
}

/** GET /partner/documents/:id/file — a partner may view only their own uploads. */
async function getMyDocumentFile(req, res) {
  const row = await db("partner_documents")
    .where({ id: req.params.id, owner_type: req.auth.type, owner_id: req.auth.id })
    .first();
  if (!row) return res.status(404).json({ error: "Document not found" });
  return sendFile(res, row);
}

// ---------- Admin ----------

/** GET /admin/documents/:ownerType/:ownerId — requirements, current documents, history, standing. */
async function getOwnerDocuments(req, res) {
  const { ownerType, ownerId } = req.params;
  const table = docs.OWNER_TABLE[ownerType];
  if (!table) return res.status(400).json({ error: "ownerType must be 'restaurant' or 'rider'" });
  const owner = await db(table).where({ id: ownerId }).select("id", "name", "phone", "status").first();
  if (!owner) return res.status(404).json({ error: "Not found" });
  res.json({ owner, ...(await docs.ownerView(ownerType, Number(ownerId), { includeHistory: true })) });
}

/**
 * GET /admin/documents?status=pending&owner_type=&page=&limit=
 * The review queue: uploads with their owner's name/phone. Pending is oldest
 * first (review in arrival order); anything else newest first.
 */
async function listDocuments(req, res) {
  const { status, owner_type: ownerType } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const base = db("partner_documents").modify((qb) => {
    if (status) qb.where({ status });
    if (ownerType) qb.where({ owner_type: ownerType });
  });
  const [{ total }] = await base.clone().count({ total: "*" });
  const rows = await base.clone().orderBy("id", status === "pending" ? "asc" : "desc").limit(limit).offset((page - 1) * limit);

  const owners = {};
  for (const [type, table] of Object.entries(docs.OWNER_TABLE)) {
    const ids = [...new Set(rows.filter((r) => r.owner_type === type).map((r) => r.owner_id))];
    if (!ids.length) continue;
    for (const o of await db(table).whereIn("id", ids).select("id", "name", "phone")) owners[`${type}:${o.id}`] = o;
  }

  res.json({
    documents: rows.map((r) => {
      const o = owners[`${r.owner_type}:${r.owner_id}`];
      return { ...docs.serialize(r), ownerType: r.owner_type, ownerId: r.owner_id, ownerName: o ? o.name : null, ownerPhone: o ? o.phone : null };
    }),
    page,
    limit,
    total: Number(total),
  });
}

/** GET /admin/documents/:id/file — streams the document (admins only; it's never public). */
async function getDocumentFile(req, res) {
  const row = await db("partner_documents").where({ id: req.params.id }).first();
  if (!row) return res.status(404).json({ error: "Document not found" });
  return sendFile(res, row);
}

/** POST /admin/documents/:id/review  body: { decision: 'approve'|'reject', reason? } */
async function reviewDocument(req, res) {
  const { decision, reason } = req.body || {};
  const result = await docs.review(req.params.id, req.auth.id, decision, reason);
  res.status(result.status).json(result.body);
}

const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function sendFile(res, row) {
  const buffer = await storage.readPartnerDocument(row.storage_path);
  res.set("Content-Type", row.content_type);
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Disposition", `inline; filename="${row.doc_type}-${row.id}.${EXT[row.content_type] || "bin"}"`);
  res.send(buffer);
}

module.exports = {
  getMyDocuments,
  uploadMyDocument,
  getMyDocumentFile,
  getOwnerDocuments,
  listDocuments,
  getDocumentFile,
  reviewDocument,
};
