const path = require("path");
const db = require("../config/db");
const storage = require("./storage.service");
const push = require("./push.service");

/**
 * Partner support: a ticket with a REPLY THREAD between a partner (kitchen now, rider next) and Fengle, with screenshots.
 * One implementation for both partner types (partner_type + partner_id). Customer complaints are a different, single-message
 * feature (supportTickets.service.js). Attachments live in the private bucket / directory (storage.savePartnerDocument) and are
 * only ever streamed by an authenticated endpoint.
 */

const CATEGORIES = ["not_receiving_orders", "login_problem", "payment_settlement", "order_cancelled", "technical", "menu_or_prices", "documents", "other"];
const STATUSES = ["open", "in_progress", "resolved"];
const MESSAGE_MIN = 10; // a new ticket's complaint
const MESSAGE_MAX = 1000;
const MAX_OPEN_TICKETS = 5; // open + in_progress at once, per partner
const MAX_TICKETS_PER_DAY = 10; // created in the last 24 h, per partner
const MAX_PARTNER_MESSAGES_PER_TICKET_PER_DAY = 20;
const MAX_ATTACHMENTS = 3;

const PARTNER_TABLE = { restaurant: "restaurants", rider: "riders" };
// The column on orders that ties an order to a partner of that type.
const ORDER_PARTNER_COLUMN = { restaurant: "restaurant_id", rider: "rider_id" };

const referenceFor = (id) => `FPS-${String(id).padStart(6, "0")}`;

class SupportError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** Validates message text. `first` = the complaint that opens a ticket (10+ chars); a reply needs 1+. Returns the trimmed text. */
function cleanMessage(raw, { first }) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const min = first ? MESSAGE_MIN : 1;
  if (text.length < min) throw new SupportError(400, first ? `Please describe the problem in at least ${MESSAGE_MIN} characters` : "Write a message first");
  if (text.length > MESSAGE_MAX) throw new SupportError(400, `The message can be at most ${MESSAGE_MAX} characters`);
  return text;
}

function cleanCategory(raw) {
  if (!CATEGORIES.includes(raw)) throw new SupportError(400, `category must be one of: ${CATEGORIES.join(", ")}`);
  return raw;
}

function cleanOrderId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new SupportError(400, "order_id must be an order number");
  return id;
}

/** A file name safe to store and to put in a header: no path, no control characters, at most 100 chars. */
function safeName(original, fallback) {
  const base = path.basename(String(original || "")).replace(/[\u0000-\u001f"\\/]/g, "").trim().slice(0, 100);
  return base || fallback;
}

/**
 * Checks the uploaded files by their bytes (JPEG / PNG / WebP / PDF — the client's Content-Type and name are ignored) and returns
 * [{ buffer, ext, name }]. Nothing is stored yet, so a bad file in the set refuses the whole request.
 */
function validateFiles(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_ATTACHMENTS) throw new SupportError(400, `Attach at most ${MAX_ATTACHMENTS} files`);
  return list.map((f, i) => {
    const ext = storage.detectDocumentType(f.buffer);
    if (!ext) throw new SupportError(400, "Only JPEG, PNG, WebP images or PDF files can be attached");
    return { buffer: f.buffer, ext, name: safeName(f.originalname, `attachment-${i + 1}.${ext}`) };
  });
}

/** Stores the validated files; returns the rows to insert once the message exists. */
async function storeFiles(validated) {
  const rows = [];
  for (const f of validated) {
    const { storagePath, contentType } = await storage.savePartnerDocument(f.buffer, f.ext);
    rows.push({ name: f.name, content_type: contentType, size: f.buffer.length, storage_path: storagePath });
  }
  return rows;
}

async function partnerExists(partnerType, partnerId) {
  return Boolean(await db(PARTNER_TABLE[partnerType]).where({ id: partnerId }).first("id"));
}

// ---------------------------------------------------------------------------
// Presenting
// ---------------------------------------------------------------------------

/** The ticket as a partner sees it (list row and detail header). Needs first_message and message_count joined in. */
function presentTicket(row) {
  return {
    id: row.id, reference: row.reference, category: row.category, order_id: row.order_id, status: row.status,
    message: row.first_message || "", message_count: Number(row.message_count || 0),
    last_message_by: row.last_message_by, last_message_at: row.last_message_at,
    created_at: row.created_at, updated_at: row.updated_at, resolved_at: row.resolved_at || null,
  };
}

/** Ticket rows with first_message + message_count, filtered by `modify`. */
function ticketsQuery() {
  return db("partner_support_tickets as t").select(
    "t.*",
    db.raw("(SELECT m.body FROM partner_support_messages m WHERE m.ticket_id = t.id ORDER BY m.id ASC LIMIT 1) as first_message"),
    db.raw("(SELECT COUNT(*) FROM partner_support_messages m WHERE m.ticket_id = t.id) as message_count")
  );
}

/** A thread: oldest first, each message with its attachments' public details (never the storage path). */
async function loadMessages(ticketId) {
  const messages = await db("partner_support_messages").where({ ticket_id: ticketId }).orderBy("id", "asc");
  const ids = messages.map((m) => m.id);
  const attachments = ids.length ? await db("partner_support_attachments").whereIn("message_id", ids).orderBy("id", "asc") : [];
  const byMessage = {};
  for (const a of attachments) (byMessage[a.message_id] ||= []).push({ id: a.id, name: a.name, content_type: a.content_type, size: a.size });
  return messages.map((m) => ({ id: m.id, author: m.author, body: m.body, created_at: m.created_at, attachments: byMessage[m.id] || [] }));
}

// ---------------------------------------------------------------------------
// Partner side
// ---------------------------------------------------------------------------

/** Opens a ticket. Throws SupportError (400 validation, 429 limits). Returns the ticket as the partner sees it. */
async function createTicket(partnerType, partnerId, { category, order_id, message, files }) {
  const cat = cleanCategory(category);
  const text = cleanMessage(message, { first: true });
  const orderId = cleanOrderId(order_id);
  const validated = validateFiles(files);

  if (orderId !== null) {
    const order = await db("orders").where({ id: orderId, [ORDER_PARTNER_COLUMN[partnerType]]: partnerId }).first("id");
    if (!order) throw new SupportError(400, "That order wasn't found on your account");
  }
  const { n: open } = await db("partner_support_tickets").where({ partner_type: partnerType, partner_id: partnerId }).whereIn("status", ["open", "in_progress"]).count({ n: "*" }).first();
  if (Number(open) >= MAX_OPEN_TICKETS) {
    throw new SupportError(429, `You already have ${MAX_OPEN_TICKETS} open tickets. Please wait for them to be resolved before raising another.`, "too_many_open_tickets");
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const { n: today } = await db("partner_support_tickets").where({ partner_type: partnerType, partner_id: partnerId }).where("created_at", ">=", since).count({ n: "*" }).first();
  if (Number(today) >= MAX_TICKETS_PER_DAY) {
    throw new SupportError(429, `You've reached today's limit of ${MAX_TICKETS_PER_DAY} tickets. Please try again tomorrow.`, "too_many_tickets_today");
  }

  const stored = await storeFiles(validated);
  const ticketId = await db.transaction(async (trx) => {
    const [id] = await trx("partner_support_tickets").insert({ partner_type: partnerType, partner_id: partnerId, order_id: orderId, category: cat });
    await trx("partner_support_tickets").where({ id }).update({ reference: referenceFor(id) });
    const [messageId] = await trx("partner_support_messages").insert({ ticket_id: id, author: "partner", body: text });
    if (stored.length) await trx("partner_support_attachments").insert(stored.map((s) => ({ ...s, message_id: messageId })));
    return id;
  });
  return presentTicket(await ticketsQuery().where("t.id", ticketId).first());
}

/** A partner's own ticket row, or null (also null for another partner's: the caller answers 404). */
function findOwn(partnerType, partnerId, ticketId) {
  const id = Number(ticketId);
  if (!Number.isInteger(id)) return Promise.resolve(null);
  return ticketsQuery().where({ "t.id": id, "t.partner_type": partnerType, "t.partner_id": partnerId }).first().then((r) => r || null);
}

/**
 * Adds a message to a thread. author 'partner' (replying to a resolved ticket reopens it) or 'admin' (a reply while open moves it to
 * in_progress unless `status` says otherwise; resolving stamps resolved_by/at). Returns { message, becameResolved }.
 */
async function addMessage(ticket, { author, adminId = null, body, files, status }) {
  const text = cleanMessage(body, { first: false });
  const validated = validateFiles(files);
  if (author === "partner") {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const { n } = await db("partner_support_messages").where({ ticket_id: ticket.id, author: "partner" }).where("created_at", ">=", since).count({ n: "*" }).first();
    if (Number(n) >= MAX_PARTNER_MESSAGES_PER_TICKET_PER_DAY) {
      throw new SupportError(429, `You've reached today's limit of ${MAX_PARTNER_MESSAGES_PER_TICKET_PER_DAY} messages on this ticket. Please try again tomorrow.`, "too_many_messages");
    }
  }
  const stored = await storeFiles(validated);
  let becameResolved = false;
  const messageId = await db.transaction(async (trx) => {
    const [id] = await trx("partner_support_messages").insert({ ticket_id: ticket.id, author, admin_id: author === "admin" ? adminId : null, body: text });
    if (stored.length) await trx("partner_support_attachments").insert(stored.map((s) => ({ ...s, message_id: id })));

    const updates = { last_message_by: author, last_message_at: trx.fn.now(), updated_at: trx.fn.now() };
    let next = ticket.status;
    if (author === "partner") {
      if (ticket.status === "resolved") next = "open"; // the partner wrote again: it is not resolved
    } else if (status) {
      next = status;
    } else if (ticket.status === "open") {
      next = "in_progress"; // somebody at Fengle has picked it up
    }
    if (next !== ticket.status) updates.status = next;
    if (next === "resolved" && ticket.status !== "resolved") { updates.resolved_by = adminId; updates.resolved_at = trx.fn.now(); becameResolved = true; }
    if (next !== "resolved" && ticket.status === "resolved") { updates.resolved_by = null; updates.resolved_at = null; }
    await trx("partner_support_tickets").where({ id: ticket.id }).update(updates);
    return id;
  });
  const [message] = (await loadMessages(ticket.id)).filter((m) => m.id === messageId);
  return { message, becameResolved };
}

/** Streams-ready read of an attachment that belongs to this ticket. Returns { buffer, row } or null. */
async function readAttachment(ticketId, attachmentId) {
  const aid = Number(attachmentId);
  if (!Number.isInteger(aid)) return null;
  const row = await db("partner_support_attachments as a")
    .join("partner_support_messages as m", "m.id", "a.message_id")
    .where({ "a.id": aid, "m.ticket_id": ticketId })
    .select("a.*")
    .first();
  if (!row) return null;
  return { row, buffer: await storage.readPartnerDocument(row.storage_path) };
}

/** Tells the partner Fengle answered. Best-effort, after the request (a push failure never fails it). */
function notifyPartner(ticket, { resolved }) {
  push.notifyLater(() => push.sendToOwner(ticket.partner_type, ticket.partner_id, {
    title: resolved ? `Your ticket ${ticket.reference} is resolved` : `Fengle replied to ${ticket.reference}`,
    body: resolved ? "Tap to read Fengle's reply." : "Tap to read the reply.",
    data: { type: "support", ticket_id: ticket.id },
  }));
}

module.exports = {
  CATEGORIES, STATUSES, MAX_OPEN_TICKETS, MAX_TICKETS_PER_DAY, MAX_PARTNER_MESSAGES_PER_TICKET_PER_DAY, MAX_ATTACHMENTS, PARTNER_TABLE,
  SupportError, referenceFor, cleanMessage, presentTicket, ticketsQuery, loadMessages, createTicket, findOwn, addMessage, readAttachment,
  notifyPartner, partnerExists,
};
