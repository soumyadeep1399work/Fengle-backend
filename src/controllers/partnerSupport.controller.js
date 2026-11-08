const db = require("../config/db");
const support = require("../services/partnerSupport.service");
const supportContact = require("../services/supportContact.service");

const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Maps a SupportError to the response; anything else is left to the central error handler. */
function fail(res, err) {
  if (err instanceof support.SupportError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
}

/**
 * The partner-side handlers for one partner type (mounted for kitchens now, riders next). Every route is allowUnverified so a partner
 * whose selfie is still under review, or was denied, can still ask for help. A token whose account row is gone gets the usual 401.
 */
function forPartner(partnerType) {
  async function guard(req, res) {
    if (await support.partnerExists(partnerType, req.auth.id)) return true;
    res.status(401).json({ error: "Invalid or expired token" });
    return false;
  }

  /** POST …/support-tickets multipart: category, order_id?, message, attachments[] -> 201 { ticket } */
  async function createTicket(req, res) {
    if (!(await guard(req, res))) return;
    try {
      const body = req.body || {};
      const ticket = await support.createTicket(partnerType, req.auth.id, { category: body.category, order_id: body.order_id, message: body.message, files: req.files });
      res.status(201).json({ ticket });
    } catch (err) { return fail(res, err); }
  }

  /** GET …/support-tickets -> { tickets } newest first, max 50 */
  async function listTickets(req, res) {
    if (!(await guard(req, res))) return;
    const rows = await support.ticketsQuery().where({ "t.partner_type": partnerType, "t.partner_id": req.auth.id }).orderBy("t.id", "desc").limit(50);
    res.json({ tickets: rows.map(support.presentTicket) });
  }

  /** GET …/support-tickets/:id -> { ticket, messages } (404 if it isn't theirs) */
  async function getTicket(req, res) {
    if (!(await guard(req, res))) return;
    const row = await support.findOwn(partnerType, req.auth.id, req.params.id);
    if (!row) return res.status(404).json({ error: "Ticket not found" });
    res.json({ ticket: support.presentTicket(row), messages: await support.loadMessages(row.id) });
  }

  /** POST …/support-tickets/:id/messages multipart: message, attachments[] -> 201 { ticket, message } (reopens a resolved ticket) */
  async function addMessage(req, res) {
    if (!(await guard(req, res))) return;
    const row = await support.findOwn(partnerType, req.auth.id, req.params.id);
    if (!row) return res.status(404).json({ error: "Ticket not found" });
    try {
      const { message } = await support.addMessage(row, { author: "partner", body: (req.body || {}).message, files: req.files });
      res.status(201).json({ ticket: support.presentTicket(await support.findOwn(partnerType, req.auth.id, row.id)), message });
    } catch (err) { return fail(res, err); }
  }

  /** GET …/support-tickets/:id/attachments/:attachmentId -> the bytes (auth required; only their own ticket's files) */
  async function getAttachment(req, res) {
    if (!(await guard(req, res))) return;
    const row = await support.findOwn(partnerType, req.auth.id, req.params.id);
    if (!row) return res.status(404).json({ error: "Ticket not found" });
    const file = await support.readAttachment(row.id, req.params.attachmentId);
    if (!file) return res.status(404).json({ error: "Attachment not found" });
    sendAttachment(res, file);
  }

  return { createTicket, listTickets, getTicket, addMessage, getAttachment };
}

function sendAttachment(res, { row, buffer }) {
  res.set("Content-Type", row.content_type);
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Disposition", `inline; filename="${String(row.name).replace(/[^\w.\- ]/g, "_") || `attachment-${row.id}.${EXT[row.content_type] || "bin"}`}"`);
  res.send(buffer);
}

/**
 * GET /support/contact — PUBLIC (the login screen shows it for "I can't log in"). What an admin saved in the panel (settings/support-contact),
 * else the SUPPORT_* env values; each field a string or null, and the app only shows what is non-null. Nothing is invented.
 */
async function getContact(req, res) {
  res.set("Cache-Control", "no-cache"); // an admin edit should show the next time the screen opens
  res.json(await supportContact.publicContact());
}

module.exports = { forPartner, getContact, sendAttachment, fail };
