const db = require("../config/db");
const support = require("../services/partnerSupport.service");
const { sendAttachment, fail } = require("./partnerSupport.controller");

/** Ticket rows with the partner's name/phone joined from whichever table its type points at. */
function adminTicketsQuery() {
  return support.ticketsQuery()
    .leftJoin("restaurants as r", function () { this.on("r.id", "=", "t.partner_id").andOn("t.partner_type", "=", db.raw("'restaurant'")); })
    .leftJoin("riders as d", function () { this.on("d.id", "=", "t.partner_id").andOn("t.partner_type", "=", db.raw("'rider'")); })
    .select(db.raw("COALESCE(r.name, d.name) as partner_name"), db.raw("COALESCE(r.phone, d.phone) as partner_phone"));
}

const presentForAdmin = (row) => ({
  ...support.presentTicket(row),
  partner_type: row.partner_type, partner_id: row.partner_id, resolved_by: row.resolved_by || null,
  partner: { type: row.partner_type, id: row.partner_id, name: row.partner_name || null, phone: row.partner_phone || null },
});

/**
 * GET /admin/partner-support-tickets?status=&category=&partner_type=&q=&limit=&offset= -> { tickets, total }
 * Open / in_progress is a work queue (oldest first); resolved or no status filter is newest first. q matches the reference or the
 * partner's name / phone.
 */
async function listTickets(req, res) {
  const { status, category, partner_type: partnerType, q } = req.query;
  if (status && !support.STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${support.STATUSES.join(", ")}` });
  if (category && !support.CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${support.CATEGORIES.join(", ")}` });
  if (partnerType && !["restaurant", "rider"].includes(partnerType)) return res.status(400).json({ error: "partner_type must be restaurant or rider" });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const term = q && String(q).trim() ? `%${String(q).trim().replace(/[%_]/g, (c) => `\\${c}`)}%` : null;
  const filter = (qb) => {
    if (status) qb.where("t.status", status);
    if (category) qb.where("t.category", category);
    if (partnerType) qb.where("t.partner_type", partnerType);
    if (term) qb.where((w) => w.where("t.reference", "like", term).orWhere("r.name", "like", term).orWhere("r.phone", "like", term).orWhere("d.name", "like", term).orWhere("d.phone", "like", term));
  };
  const oldestFirst = status === "open" || status === "in_progress";
  const rows = await adminTicketsQuery().modify(filter).orderBy("t.id", oldestFirst ? "asc" : "desc").limit(limit).offset(offset);
  const { n } = await db("partner_support_tickets as t")
    .leftJoin("restaurants as r", function () { this.on("r.id", "=", "t.partner_id").andOn("t.partner_type", "=", db.raw("'restaurant'")); })
    .leftJoin("riders as d", function () { this.on("d.id", "=", "t.partner_id").andOn("t.partner_type", "=", db.raw("'rider'")); })
    .modify(filter).count({ n: "*" }).first();
  res.json({ tickets: rows.map(presentForAdmin), total: Number(n) });
}

/** GET /admin/partner-support-tickets/summary -> { open, in_progress, restaurant: {open, in_progress}, rider: {open, in_progress} } (nav badge) */
async function summary(req, res) {
  const rows = await db("partner_support_tickets").whereIn("status", ["open", "in_progress"]).select("partner_type", "status").count({ n: "*" }).groupBy("partner_type", "status");
  const out = { open: 0, in_progress: 0, restaurant: { open: 0, in_progress: 0 }, rider: { open: 0, in_progress: 0 } };
  for (const r of rows) { out[r.status] += Number(r.n); out[r.partner_type][r.status] += Number(r.n); }
  res.json(out);
}

/** The order a ticket is about, as an admin may see it: never the kitchen payable or vendor cost. */
async function orderSummary(orderId) {
  if (!orderId) return null;
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) return null;
  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).select("id", "name").first();
  return {
    id: order.id, status: order.status, total: Number(order.grand_total), payment_method: order.payment_method, payment_status: order.payment_status,
    restaurant: restaurant ? { id: restaurant.id, name: restaurant.name } : null, rider_id: order.rider_id || null, placed_at: order.created_at,
  };
}

async function loadTicket(id) {
  const n = Number(id);
  return Number.isInteger(n) ? adminTicketsQuery().where("t.id", n).first() : null;
}

/** GET /admin/partner-support-tickets/:id -> { ticket, partner, order | null, messages } */
async function getTicket(req, res) {
  const row = await loadTicket(req.params.id);
  if (!row) return res.status(404).json({ error: "Ticket not found" });
  const t = presentForAdmin(row);
  res.json({ ticket: t, partner: t.partner, order: await orderSummary(row.order_id), messages: await support.loadMessages(row.id) });
}

/**
 * POST /admin/partner-support-tickets/:id/messages multipart: message, status?, attachments[] -> 201 { ticket, message }
 * Fengle's reply. A reply while the ticket is open moves it to in_progress; `status` ('open' | 'in_progress' | 'resolved') overrides.
 * The reply is the note that lets a ticket be resolved. Pushes the partner.
 */
async function reply(req, res) {
  const row = await loadTicket(req.params.id);
  if (!row) return res.status(404).json({ error: "Ticket not found" });
  const { message, status } = req.body || {};
  if (status !== undefined && status !== "" && !support.STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${support.STATUSES.join(", ")}` });
  try {
    const { message: saved, becameResolved } = await support.addMessage(row, { author: "admin", adminId: req.auth.id, body: message, files: req.files, status: status || undefined });
    support.notifyPartner(row, { resolved: becameResolved });
    res.status(201).json({ ticket: presentForAdmin(await loadTicket(row.id)), message: saved });
  } catch (err) { return fail(res, err); }
}

/**
 * PATCH /admin/partner-support-tickets/:id { status, message? } -> { ticket }
 * Changes the status without necessarily writing a reply. Resolving needs a reply from Fengle: an optional `message` is added as that
 * reply, otherwise the ticket must already have one. Moving a resolved ticket back clears who/when resolved it.
 */
async function updateStatus(req, res) {
  const row = await loadTicket(req.params.id);
  if (!row) return res.status(404).json({ error: "Ticket not found" });
  const { status, message } = req.body || {};
  if (!support.STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${support.STATUSES.join(", ")}` });
  try {
    if (message !== undefined && String(message).trim() !== "") {
      const { becameResolved } = await support.addMessage(row, { author: "admin", adminId: req.auth.id, body: message, files: req.files, status });
      support.notifyPartner(row, { resolved: becameResolved });
      return res.json({ ticket: presentForAdmin(await loadTicket(row.id)) });
    }
    if (status === "resolved" && row.status !== "resolved") {
      const { n } = await db("partner_support_messages").where({ ticket_id: row.id, author: "admin" }).count({ n: "*" }).first();
      if (Number(n) === 0) return res.status(400).json({ error: "Reply to the partner before resolving the ticket (send a message with the status)" });
    }
    if (status !== row.status) {
      const updates = { status, updated_at: db.fn.now() };
      if (status === "resolved") { updates.resolved_by = req.auth.id; updates.resolved_at = db.fn.now(); } else { updates.resolved_by = null; updates.resolved_at = null; }
      await db("partner_support_tickets").where({ id: row.id }).update(updates);
      if (status === "resolved") support.notifyPartner(row, { resolved: true });
    }
    res.json({ ticket: presentForAdmin(await loadTicket(row.id)) });
  } catch (err) { return fail(res, err); }
}

/** GET /admin/partner-support-tickets/:id/attachments/:attachmentId -> the partner's screenshot / file */
async function getAttachment(req, res) {
  const row = await loadTicket(req.params.id);
  if (!row) return res.status(404).json({ error: "Ticket not found" });
  const file = await support.readAttachment(row.id, req.params.attachmentId);
  if (!file) return res.status(404).json({ error: "Attachment not found" });
  sendAttachment(res, file);
}

module.exports = { listTickets, summary, getTicket, reply, updateStatus, getAttachment };
