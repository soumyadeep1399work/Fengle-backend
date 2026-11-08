const db = require("../config/db");
const support = require("../services/supportTickets.service");

/** POST /support/tickets { category, order_id?, message } -> 201 { ticket } */
async function createTicket(req, res) {
  const v = support.validateNew(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const result = await support.createTicket(req.auth.id, v.value);
  if (result.error) return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  res.status(201).json({ ticket: result.ticket });
}

/** GET /support/tickets -> { tickets } newest first, the customer's own, at most 50 */
async function listMyTickets(req, res) {
  const rows = await db("support_tickets").where({ customer_id: req.auth.id }).orderBy("id", "desc").limit(50);
  res.json({ tickets: rows.map(support.presentForCustomer) });
}

/** GET /support/tickets/:id -> { ticket } (404 if it isn't theirs) */
async function getMyTicket(req, res) {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? await db("support_tickets").where({ id, customer_id: req.auth.id }).first() : null;
  if (!row) return res.status(404).json({ error: "Complaint not found" });
  res.json({ ticket: support.presentForCustomer(row) });
}

module.exports = { createTicket, listMyTickets, getMyTicket };
