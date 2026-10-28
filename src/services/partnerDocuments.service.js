// Partner KYC / licence documents (added 2026-10-28). The single place the rules
// live: which documents each partner type needs, how an upload is validated, how
// a partner's overall standing is computed, and the routing/assignment gate.
//
// "Current" document of a type = the partner's latest upload of it (what the
// portal and the admin panel show). "Effective" = their latest APPROVED upload of
// it (what counts for blocking) — so re-uploading a renewed licence never
// interrupts a partner whose previous one is still approved and in date.
const db = require("../config/db");
const storage = require("./storage.service");
const { sendToOwner, notifyLater } = require("./push.service");

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const EXPIRING_SOON_DAYS = 30;
const NO_EXPIRY = "9999-12-31"; // documents_valid_until when no required document expires (e.g. Aadhaar only)

const OWNER_TABLE = { restaurant: "restaurants", rider: "riders" };
const PORTAL_URL = process.env.PARTNER_PORTAL_URL || "https://partner.fengle.in";

const REQUIREMENTS = {
  restaurant: [
    {
      type: "aadhaar", label: "Owner's Aadhaar", required: true, needsNumber: false, needsExpiry: false,
      hint: "Upload a masked Aadhaar (only the last 4 digits visible). You can download one from the UIDAI website.",
    },
    {
      type: "fssai", label: "FSSAI licence", required: true, needsNumber: true, needsExpiry: true,
      numberLabel: "FSSAI licence number", hint: "The 14-digit licence or registration number printed on the certificate.",
    },
    {
      type: "trade_license", label: "Trade licence", required: true, needsNumber: true, needsExpiry: true,
      numberLabel: "Trade licence number", hint: "Issued by your municipal corporation.",
    },
  ],
  rider: [
    {
      type: "aadhaar", label: "Aadhaar", required: true, needsNumber: false, needsExpiry: false,
      hint: "Upload a masked Aadhaar (only the last 4 digits visible). You can download one from the UIDAI website.",
    },
    {
      type: "driving_license", label: "Driving licence", required: false, needsNumber: true, needsExpiry: true,
      numberLabel: "Driving licence number", hint: "Optional, but helps us approve you faster.",
    },
  ],
};

const DOC_LABEL = { aadhaar: "Aadhaar", fssai: "FSSAI licence", trade_license: "Trade licence", driving_license: "Driving licence" };

// FSSAI numbers are exactly 14 digits; other licence numbers vary by issuing
// authority, so they only get a loose shape check (letters, digits, / - space).
const NUMBER_RULES = {
  fssai: { pattern: /^\d{14}$/, message: "FSSAI licence number must be exactly 14 digits" },
  trade_license: { pattern: /^[A-Z0-9][A-Z0-9/\- ]{2,39}$/, message: "Enter a valid trade licence number (letters, digits, / or -)" },
  driving_license: { pattern: /^[A-Z0-9][A-Z0-9/\- ]{5,39}$/, message: "Enter a valid driving licence number" },
};

/** Today's date in India as YYYY-MM-DD (expiry dates are calendar dates, not instants). */
function todayIST(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

/** MySQL DATE (mysql2 gives a local-midnight Date) or a string -> YYYY-MM-DD, or null. */
function toDateString(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
}

function requirementFor(ownerType, docType) {
  return (REQUIREMENTS[ownerType] || []).find((r) => r.type === docType) || null;
}

function documentsEnforced() {
  return process.env.PARTNER_DOCUMENTS_ENFORCED === "true";
}

/**
 * Knex modifier for routing / catalog / rider assignment: while enforcement is on,
 * only partners whose required documents are all approved and in date qualify.
 * `column` is e.g. "restaurants.documents_valid_until".
 */
function applyDocumentsGate(qb, column) {
  if (documentsEnforced()) qb.where(column, ">=", todayIST());
}

/** For single-partner checks (admin manual rider reassignment). */
function partnerMeetsDocuments(row) {
  if (!documentsEnforced()) return true;
  const until = toDateString(row && row.documents_valid_until);
  return !!until && until >= todayIST();
}

/**
 * Validates an upload's form fields for its document type.
 * Returns { error } or { fields: { doc_number, expiry_date } }.
 */
function validateFields(ownerType, docType, body) {
  const req = requirementFor(ownerType, docType);
  if (!req) {
    const allowed = (REQUIREMENTS[ownerType] || []).map((r) => r.type).join(", ");
    return { error: `doc_type must be one of: ${allowed}` };
  }

  const fields = { doc_number: null, expiry_date: null };

  if (req.needsNumber) {
    const raw = typeof body.doc_number === "string" ? body.doc_number : "";
    const number = raw.trim().toUpperCase().replace(/\s+/g, " ");
    if (!number) return { error: `${req.numberLabel} is required` };
    const rule = NUMBER_RULES[docType];
    const normalized = docType === "fssai" ? number.replace(/\s/g, "") : number;
    if (rule && !rule.pattern.test(normalized)) return { error: rule.message };
    fields.doc_number = normalized;
  }

  if (req.needsExpiry) {
    const expiry = typeof body.expiry_date === "string" ? body.expiry_date.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) {
      return { error: "expiry_date is required (YYYY-MM-DD)" };
    }
    if (expiry < todayIST()) return { error: "This document has already expired. Please upload a valid one." };
    fields.expiry_date = expiry;
  }

  return { fields };
}

function serialize(row) {
  return {
    id: row.id,
    docType: row.doc_type,
    label: DOC_LABEL[row.doc_type],
    status: row.status,
    docNumber: row.doc_number,
    expiryDate: toDateString(row.expiry_date),
    rejectionReason: row.rejection_reason,
    contentType: row.content_type,
    fileSize: row.file_size,
    uploadedAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/** Latest row per doc_type, and latest approved row per doc_type, from rows sorted by id ascending. */
function pickCurrentAndEffective(rows) {
  const current = {};
  const effective = {};
  for (const r of rows) {
    current[r.doc_type] = r;
    if (r.status === "approved") effective[r.doc_type] = r;
  }
  return { current, effective };
}

/**
 * A partner's overall standing from their document rows (sorted by id asc).
 * status:
 *   complete   — every required document approved and in date
 *   expiring   — complete, but one expires within EXPIRING_SOON_DAYS
 *   pending    — not complete, and something is waiting for review
 *   rejected   — not complete, and a required document was rejected (nothing pending)
 *   expired    — not complete only because an approved document has expired
 *   missing    — not complete, and a required document was never uploaded
 */
function summarize(ownerType, rows) {
  const { current, effective } = pickCurrentAndEffective(rows);
  const today = todayIST();
  const soon = todayIST(EXPIRING_SOON_DAYS);
  const required = REQUIREMENTS[ownerType].filter((r) => r.required).map((r) => r.type);

  let validUntil = NO_EXPIRY;
  const missing = [];
  let anyExpired = false;
  let complete = true;
  for (const type of required) {
    const eff = effective[type];
    if (!current[type]) missing.push(type);
    if (!eff) { complete = false; validUntil = null; continue; }
    const exp = toDateString(eff.expiry_date);
    if (exp && exp < today) { complete = false; anyExpired = true; validUntil = null; continue; }
    if (validUntil && exp && exp < validUntil) validUntil = exp;
  }

  const pendingCount = Object.values(current).filter((r) => r.status === "pending").length;
  const requiredRejected = required.some((t) => current[t] && current[t].status === "rejected");

  let status;
  if (complete) status = validUntil !== NO_EXPIRY && validUntil <= soon ? "expiring" : "complete";
  else if (required.some((t) => current[t] && current[t].status === "pending")) status = "pending";
  else if (requiredRejected) status = "rejected";
  else if (anyExpired && missing.length === 0) status = "expired";
  else status = "missing";

  return { status, complete, validUntil: complete ? validUntil : null, missing, pendingCount };
}

async function rowsFor(ownerType, ownerId, trx = db) {
  return trx("partner_documents").where({ owner_type: ownerType, owner_id: ownerId }).orderBy("id", "asc");
}

/**
 * Recomputes the denormalized documents_valid_until on the partner row (see the
 * migration): the earliest expiry among effective required documents, or NULL.
 * An already-expired document is stored as its (past) date, which the gate's
 * ">= today" comparison rejects on its own.
 */
async function recomputeValidity(ownerType, ownerId, trx = db) {
  const rows = await rowsFor(ownerType, ownerId, trx);
  const { effective } = pickCurrentAndEffective(rows);
  let until = NO_EXPIRY;
  for (const req of REQUIREMENTS[ownerType].filter((r) => r.required)) {
    const eff = effective[req.type];
    if (!eff) { until = null; break; }
    const exp = toDateString(eff.expiry_date);
    if (exp && exp < until) until = exp;
  }
  await trx(OWNER_TABLE[ownerType]).where({ id: ownerId }).update({ documents_valid_until: until });
  return until;
}

/** Everything the portal (and the admin detail card) needs for one partner. */
async function ownerView(ownerType, ownerId, { includeHistory = false } = {}) {
  const rows = await rowsFor(ownerType, ownerId);
  const { current, effective } = pickCurrentAndEffective(rows);
  const documents = {};
  for (const req of REQUIREMENTS[ownerType]) {
    const cur = current[req.type];
    const eff = effective[req.type];
    documents[req.type] = cur
      ? { ...serialize(cur), approvedVersion: eff && eff.id !== cur.id ? serialize(eff) : null }
      : null;
  }
  return {
    ownerType,
    enforced: documentsEnforced(),
    requirements: REQUIREMENTS[ownerType],
    documents,
    summary: summarize(ownerType, rows),
    ...(includeHistory ? { history: rows.slice().reverse().map(serialize) } : {}),
  };
}

/** Summaries for many partners at once (admin list pages): Map(ownerId -> summary). */
async function summariesFor(ownerType, ownerIds) {
  const result = new Map();
  if (!ownerIds.length) return result;
  const rows = await db("partner_documents")
    .where({ owner_type: ownerType })
    .whereIn("owner_id", ownerIds)
    .orderBy("id", "asc");
  const byOwner = new Map(ownerIds.map((id) => [Number(id), []]));
  for (const r of rows) byOwner.get(Number(r.owner_id))?.push(r);
  for (const [id, list] of byOwner) result.set(id, summarize(ownerType, list));
  return result;
}

/**
 * Stores an upload. `file` is multer's { buffer }. Returns { status, body }.
 * A new upload is always 'pending'; previously approved versions keep counting
 * until this one is reviewed.
 */
async function upload(ownerType, ownerId, body, file) {
  const docType = typeof body.doc_type === "string" ? body.doc_type.trim() : "";
  const validated = validateFields(ownerType, docType, body);
  if (validated.error) return { status: 400, body: { error: validated.error } };
  if (!file || !file.buffer || !file.buffer.length) {
    return { status: 400, body: { error: "A file is required (multipart/form-data, field name 'file')" } };
  }
  const ext = storage.detectDocumentType(file.buffer);
  if (!ext) return { status: 400, body: { error: "Only JPEG, PNG, WebP or PDF files are accepted" } };

  const { storagePath, contentType } = await storage.savePartnerDocument(file.buffer, ext);
  const [id] = await db("partner_documents").insert({
    owner_type: ownerType,
    owner_id: ownerId,
    doc_type: docType,
    storage_path: storagePath,
    content_type: contentType,
    file_size: file.buffer.length,
    ...validated.fields,
    status: "pending",
  });
  await recomputeValidity(ownerType, ownerId);
  const row = await db("partner_documents").where({ id }).first();
  return { status: 201, body: { document: serialize(row) } };
}

/** Admin approve/reject of one uploaded document. Returns { status, body }. */
async function review(documentId, adminId, decision, reason) {
  if (!["approve", "reject"].includes(decision)) {
    return { status: 400, body: { error: "decision must be 'approve' or 'reject'" } };
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (decision === "reject") {
    if (!trimmed) return { status: 400, body: { error: "A reason is required when rejecting" } };
    if (trimmed.length > 255) return { status: 400, body: { error: "reason must be at most 255 characters" } };
  }

  const row = await db("partner_documents").where({ id: documentId }).first();
  if (!row) return { status: 404, body: { error: "Document not found" } };

  await db("partner_documents").where({ id: documentId }).update({
    status: decision === "approve" ? "approved" : "rejected",
    rejection_reason: decision === "reject" ? trimmed : null,
    reviewed_by_admin_id: adminId,
    reviewed_at: new Date(),
  });
  await recomputeValidity(row.owner_type, row.owner_id);

  const label = DOC_LABEL[row.doc_type];
  notifyLater(() =>
    sendToOwner(row.owner_type, row.owner_id, decision === "approve"
      ? { title: `${label} approved`, body: `Your ${label} has been verified.`, data: { type: "documents", status: "approved" } }
      : { title: `${label} not approved`, body: `Please upload it again at ${PORTAL_URL.replace(/^https?:\/\//, "")}. Reason: ${trimmed}`, data: { type: "documents", status: "rejected" } })
  );

  const updated = await db("partner_documents").where({ id: documentId }).first();
  return { status: 200, body: { document: serialize(updated) } };
}

module.exports = {
  REQUIREMENTS,
  MAX_DOCUMENT_BYTES,
  OWNER_TABLE,
  PORTAL_URL,
  todayIST,
  toDateString,
  documentsEnforced,
  applyDocumentsGate,
  partnerMeetsDocuments,
  validateFields,
  serialize,
  summarize,
  recomputeValidity,
  ownerView,
  summariesFor,
  upload,
  review,
};
