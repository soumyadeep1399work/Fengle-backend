const db = require("../config/db");
const support = require("../services/supportTickets.service");
const push = require("../services/push.service"); // called as push.x so a test can spy on the push

const customerOf = (row) => ({ id: row.customer_id, name: row.customer_name, phone: row.customer_phone });

function baseQuery() {
  return db("support_tickets as t")
    .join("users as u", "u.id", "t.customer_id")
    .leftJoin("admins as a", "a.id", "t.resolved_by")
    .select("t.*", "u.name as customer_name", "u.phone as customer_phone", "a.name as resolved_by_name");
}

/**
 * GET /admin/support-tickets?status=&category=&q=&limit=&offset= -> { tickets: [ticket + customer], total }
 * Order is chosen here: open / in_progress is a work queue, so the longest-waiting complaint is first (oldest first); resolved or no
 * status filter is newest first.
 */
async function listTickets(req, res) {
  const { status, category, q } = req.query;
  if (status !== undefined && status !== "" && !support.STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${support.STATUSES.join(", ")}` });
  if (category !== undefined && category !== "" && !support.CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${support.CATEGORIES.join(", ")}` });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const filter = (qb) => {
    if (status) qb.where("t.status", status);
    if (category) qb.where("t.category", category);
    if (q && String(q).trim()) {
      const term = `%${String(q).trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
      qb.where((w) => w.where("t.reference", "like", term).orWhere("u.phone", "like", term).orWhere("u.name", "like", term));
    }
  };
  const oldestFirst = status === "open" || status === "in_progress";
  const rows = await baseQuery().modify(filter).orderBy("t.id", oldestFirst ? "asc" : "desc").limit(limit).offset(offset);
  const { n } = await db("support_tickets as t").join("users as u", "u.id", "t.customer_id").modify(filter).count({ n: "*" }).first();
  res.json({ tickets: rows.map((r) => ({ ...support.presentForAdmin(r), customer: customerOf(r) })), total: Number(n) });
}

/** GET /admin/support-tickets/summary -> { open, in_progress } (cheap, for a nav badge) */
async function summary(req, res) {
  const rows = await db("support_tickets").whereIn("status", ["open", "in_progress"]).select("status").count({ n: "*" }).groupBy("status");
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  res.json({ open: by.open || 0, in_progress: by.in_progress || 0 });
}

/** The order a complaint is about, as an admin may see it: never the kitchen payable / vendor cost. */
async function orderSummary(orderId) {
  if (!orderId) return null;
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) return null;
  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).select("id", "name").first();
  const categories = await db("order_items").join("categories", "categories.id", "order_items.category_id").where("order_items.order_id", orderId).distinct("categories.name");
  return {
    id: order.id, status: order.status, total: Number(order.grand_total), payment_method: order.payment_method, payment_status: order.payment_status,
    restaurant: restaurant ? { id: restaurant.id, name: restaurant.name } : null, categories: categories.map((c) => c.name), placed_at: order.created_at,
  };
}

/** GET /admin/support-tickets/:id -> { ticket, customer, order | null } */
async function getTicket(req, res) {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? await baseQuery().where("t.id", id).first() : null;
  if (!row) return res.status(404).json({ error: "Complaint not found" });
  res.json({ ticket: support.presentForAdmin(row), customer: customerOf(row), order: await orderSummary(row.order_id) });
}

/**
 * PATCH /admin/support-tickets/:id { status?, resolution_note? } -> { ticket }
 * Becoming 'resolved' needs a resolution_note and stamps resolved_by/resolved_at, and pushes the customer once. Moving back to
 * open / in_progress (a reopen) clears the stamp. Every admin role may do this (support is the team that works the queue).
 */
async function updateTicket(req, res) {
  const id = Number(req.params.id);
  const existing = Number.isInteger(id) ? await db("support_tickets").where({ id }).first() : null;
  if (!existing) return res.status(404).json({ error: "Complaint not found" });
  const { status, resolution_note } = req.body || {};
  if (status === undefined && resolution_note === undefined) return res.status(400).json({ error: "Send a status and/or a resolution_note" });
  if (status !== undefined && !support.STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${support.STATUSES.join(", ")}` });
  if (resolution_note !== undefined && resolution_note !== null && typeof resolution_note !== "string") return res.status(400).json({ error: "resolution_note must be text" });

  const noteInput = resolution_note === undefined ? undefined : (resolution_note === null ? "" : resolution_note.trim());
  if (noteInput !== undefined && noteInput.length > support.NOTE_MAX) return res.status(400).json({ error: `resolution_note can be at most ${support.NOTE_MAX} characters` });
  const newStatus = status || existing.status;
  const newNote = noteInput === undefined ? (existing.resolution_note || "") : noteInput;
  if (newStatus === "resolved" && !newNote) return res.status(400).json({ error: "A resolution note is required to resolve a complaint" });

  const updates = { updated_at: db.fn.now() };
  if (noteInput !== undefined) updates.resolution_note = newNote || null;
  const becomesResolved = newStatus === "resolved" && existing.status !== "resolved";
  if (status !== undefined) updates.status = status;
  if (becomesResolved) { updates.resolved_by = req.auth.id; updates.resolved_at = db.fn.now(); }
  if (status !== undefined && status !== "resolved") { updates.resolved_by = null; updates.resolved_at = null; }
  await db("support_tickets").where({ id }).update(updates);

  if (becomesResolved) {
    push.notifyLater(() => push.sendToOwner("customer", existing.customer_id, {
      title: `Your complaint ${existing.reference} is resolved`, body: newNote.length > 120 ? `${newNote.slice(0, 117)}...` : newNote,
      data: { type: "support", ticket_id: existing.id },
    }));
  }
  res.json({ ticket: support.presentForAdmin(await baseQuery().where("t.id", id).first()) });
}

module.exports = { listTickets, summary, getTicket, updateTicket };
