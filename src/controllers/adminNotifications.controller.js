const db = require("../config/db");
const campaigns = require("../services/campaign.service");
const { paginationParams } = require("../utils/pagination");

const KINDS = ["promotion", "service"];
const AUDIENCE_TYPES = ["all", "filtered", "phones"];
const STATUSES = ["scheduled", "sending", "sent", "cancelled", "failed"];
const MAX_PHONES = 5000;

const nonNegInt = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);

/** Validates the audience part of a request. Returns { error } or { audience_type, filters, phones }. */
function parseAudience(audience) {
  if (!audience || typeof audience !== "object") return { error: `audience is required: { type: ${AUDIENCE_TYPES.join(" | ")}, ... }` };
  if (!AUDIENCE_TYPES.includes(audience.type)) return { error: `audience.type must be one of: ${AUDIENCE_TYPES.join(", ")}` };

  if (audience.type === "phones") {
    if (!Array.isArray(audience.phones) || audience.phones.length === 0) return { error: "audience.phones must be a non-empty list of phone numbers" };
    if (audience.phones.length > MAX_PHONES) return { error: `audience.phones can hold at most ${MAX_PHONES} numbers` };
    const phones = new Set();
    for (const raw of audience.phones) {
      const digits = String(raw).replace(/\D/g, "");
      const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
      if (!/^\d{10}$/.test(ten)) return { error: `"${raw}" is not a 10-digit phone number` };
      phones.add(ten);
    }
    return { audience_type: "phones", phones: [...phones] };
  }

  if (audience.type === "filtered") {
    const f = audience.filters || {};
    const clean = {};
    for (const key of ["min_orders", "max_orders", "inactive_days", "ordered_category_id"]) {
      if (f[key] === undefined || f[key] === null || f[key] === "") continue;
      const n = nonNegInt(f[key]);
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return { error: `audience.filters.${key} must be a whole number of 0 or more` };
      clean[key] = n;
    }
    if (clean.min_orders !== undefined && clean.max_orders !== undefined && clean.min_orders > clean.max_orders) return { error: "audience.filters.min_orders can't be above max_orders" };
    return { audience_type: "filtered", filters: clean };
  }
  return { audience_type: "all" };
}

function present(r) {
  return {
    id: r.id, title: r.title, body: r.body, kind: r.kind,
    audience: { type: r.audience_type, filters: campaigns.parseJson(r.audience_filters, {}), phones: campaigns.parseJson(r.audience_phones, []) },
    scheduled_at: r.scheduled_at, status: r.status,
    targeted_customers: r.targeted_customers, targeted_devices: r.targeted_devices, sent_count: r.sent_count, failed_count: r.failed_count,
    error: r.error, created_by_admin_id: r.created_by_admin_id, created_by_admin_name: r.created_by_admin_name ?? undefined,
    sent_at: r.sent_at, cancelled_at: r.cancelled_at, created_at: r.created_at,
  };
}

async function load(id) {
  const row = await db("notification_campaigns as c").leftJoin("admins as a", "a.id", "c.created_by_admin_id").where("c.id", id).first("c.*", "a.name as created_by_admin_name");
  return row ? present(row) : null;
}

/**
 * POST /admin/notifications/preview { kind, audience } → { customers, devices, matched, opted_out_excluded }
 * How many customers (and devices) a campaign would reach right now — nothing is sent. super_admin only.
 */
async function preview(req, res) {
  const { kind, audience } = req.body || {};
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  const aud = parseAudience(audience);
  if (aud.error) return res.status(400).json({ error: aud.error });
  const { customerIds, matched, optedOutExcluded } = await campaigns.resolveAudience({ ...aud, kind });
  let devices = 0;
  for (let i = 0; i < customerIds.length; i += 1000) {
    const [{ n }] = await db("device_tokens").where({ owner_type: "customer" }).whereIn("owner_id", customerIds.slice(i, i + 1000)).countDistinct({ n: "token" });
    devices += Number(n);
  }
  res.json({ customers: customerIds.length, devices, matched, opted_out_excluded: optedOutExcluded });
}

/**
 * POST /admin/notifications { title, body, kind: promotion|service, audience: { type: all|filtered|phones, filters?, phones? }, scheduled_at? }
 * super_admin only. Leave scheduled_at out to send now; otherwise it must be at least a minute ahead (and at most a year).
 * → 201 { campaign }. `promotion` respects customers' "Offers & news" opt-out; `service` goes to everyone targeted.
 */
async function createCampaign(req, res) {
  const { title, body, kind, audience, scheduled_at } = req.body || {};
  if (typeof title !== "string" || !title.trim() || title.trim().length > 100) return res.status(400).json({ error: "title must be 1 to 100 characters" });
  if (typeof body !== "string" || !body.trim() || body.trim().length > 500) return res.status(400).json({ error: "body must be 1 to 500 characters" });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  const aud = parseAudience(audience);
  if (aud.error) return res.status(400).json({ error: aud.error });

  let when = null;
  if (scheduled_at !== undefined && scheduled_at !== null && scheduled_at !== "") {
    when = new Date(scheduled_at);
    if (typeof scheduled_at === "boolean" || Number.isNaN(when.getTime())) return res.status(400).json({ error: "scheduled_at must be a valid date-time" });
    if (when.getTime() < Date.now() + 60 * 1000) return res.status(400).json({ error: "scheduled_at must be at least a minute in the future (leave it out to send now)" });
    if (when.getTime() > Date.now() + 365 * 86400e3) return res.status(400).json({ error: "scheduled_at can be at most a year ahead" });
  }
  const sendNow = when === null;

  const [id] = await db("notification_campaigns").insert({
    title: title.trim(), body: body.trim(), kind, audience_type: aud.audience_type,
    audience_filters: aud.filters ? JSON.stringify(aud.filters) : null,
    audience_phones: aud.phones ? JSON.stringify(aud.phones) : null,
    scheduled_at: sendNow ? new Date() : when,
    status: sendNow ? "sending" : "scheduled", // a send-now campaign is claimed at creation so the scheduler can't also pick it up
    created_by_admin_id: req.auth.id,
  });
  if (sendNow) setImmediate(() => campaigns.runCampaign(id));
  res.status(201).json({ campaign: await load(id) });
}

/** GET /admin/notifications?status=&kind=&page=&limit= → { campaigns, page, limit, total } newest first (history). super_admin only. */
async function listCampaigns(req, res) {
  const { status, kind } = req.query;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
  if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  const { page, limit, offset } = paginationParams(req);
  let base = db("notification_campaigns as c");
  if (status) base = base.where("c.status", status);
  if (kind) base = base.where("c.kind", kind);
  const [{ n }] = await base.clone().count({ n: "*" });
  const rows = await base.clone().leftJoin("admins as a", "a.id", "c.created_by_admin_id")
    .orderBy("c.id", "desc").limit(limit).offset(offset).select("c.*", "a.name as created_by_admin_name");
  res.json({ campaigns: rows.map(present), page, limit, total: Number(n) });
}

/** GET /admin/notifications/:id → { campaign } */
async function getCampaign(req, res) {
  const campaign = await load(Number(req.params.id));
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json({ campaign });
}

/** POST /admin/notifications/:id/cancel — only while it is still `scheduled` (409 once it is sending/sent/cancelled/failed). */
async function cancelCampaign(req, res) {
  const id = Number(req.params.id);
  const n = await db("notification_campaigns").where({ id, status: "scheduled" }).update({ status: "cancelled", cancelled_at: new Date(), updated_at: db.fn.now() });
  if (n === 1) return res.json({ campaign: await load(id) });
  const existing = await load(id);
  if (!existing) return res.status(404).json({ error: "Campaign not found" });
  res.status(409).json({ error: `Only a scheduled campaign can be cancelled — this one is ${existing.status}` });
}

module.exports = { preview, createCampaign, listCampaigns, getCampaign, cancelCampaign };
