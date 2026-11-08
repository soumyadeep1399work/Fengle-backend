const db = require("../config/db");

const CATEGORIES = ["order_issue", "missing_item", "payment_failed", "refund", "delivery_delay", "general"];
const STATUSES = ["open", "in_progress", "resolved"];
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 1000;
const NOTE_MAX = 1000;
const MAX_OPEN_TICKETS = 5; // open + in_progress at once, per customer
const MAX_PER_DAY = 10; // created in the last 24 h, per customer

/** "FSP-000123" from the row id. */
const referenceFor = (id) => `FSP-${String(id).padStart(6, "0")}`;

/** What the customer sees of a ticket. */
function presentForCustomer(row) {
  return {
    id: row.id, reference: row.reference, category: row.category, order_id: row.order_id, message: row.message, status: row.status,
    resolution_note: row.resolution_note || null, created_at: row.created_at, updated_at: row.updated_at, resolved_at: row.resolved_at || null,
  };
}

/** The admin's view: the customer's version plus who resolved it. */
function presentForAdmin(row) {
  return { ...presentForCustomer(row), customer_id: row.customer_id, resolved_by: row.resolved_by || null, resolved_by_name: row.resolved_by_name || null };
}

/** Validates a new complaint. Returns { error } or { value: { category, order_id, message } }. */
function validateNew(body) {
  const b = body || {};
  if (!CATEGORIES.includes(b.category)) return { error: `category must be one of: ${CATEGORIES.join(", ")}` };
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (message.length < MESSAGE_MIN) return { error: `Please describe the problem in at least ${MESSAGE_MIN} characters` };
  if (message.length > MESSAGE_MAX) return { error: `The message can be at most ${MESSAGE_MAX} characters` };
  let orderId = null;
  if (b.order_id !== undefined && b.order_id !== null && b.order_id !== "") {
    orderId = Number(b.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) return { error: "order_id must be an order number" };
  }
  return { value: { category: b.category, order_id: orderId, message } };
}

/** Files a complaint for a customer. Returns { ticket } or { status, error, code? } for the caller to send. */
async function createTicket(customerId, input) {
  if (input.order_id !== null) {
    const order = await db("orders").where({ id: input.order_id, customer_id: customerId }).select("id").first();
    if (!order) return { status: 400, error: "That order wasn't found on your account" };
  }
  const { n: openCount } = await db("support_tickets").where({ customer_id: customerId }).whereIn("status", ["open", "in_progress"]).count({ n: "*" }).first();
  if (Number(openCount) >= MAX_OPEN_TICKETS) {
    return { status: 429, code: "too_many_open_tickets", error: `You already have ${MAX_OPEN_TICKETS} open complaints. Please wait for them to be resolved before filing another.` };
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const { n: todayCount } = await db("support_tickets").where({ customer_id: customerId }).where("created_at", ">=", since).count({ n: "*" }).first();
  if (Number(todayCount) >= MAX_PER_DAY) {
    return { status: 429, code: "too_many_tickets_today", error: `You've reached today's limit of ${MAX_PER_DAY} complaints. Please try again tomorrow.` };
  }
  const id = await db.transaction(async (trx) => {
    const [newId] = await trx("support_tickets").insert({ customer_id: customerId, order_id: input.order_id, category: input.category, message: input.message });
    await trx("support_tickets").where({ id: newId }).update({ reference: referenceFor(newId) });
    return newId;
  });
  return { ticket: presentForCustomer(await db("support_tickets").where({ id }).first()) };
}

module.exports = { CATEGORIES, STATUSES, NOTE_MAX, MAX_OPEN_TICKETS, MAX_PER_DAY, referenceFor, presentForCustomer, presentForAdmin, validateNew, createTicket };
