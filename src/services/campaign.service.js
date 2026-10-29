const db = require("../config/db");
const { promoOptIn, sendToCustomerDevices } = require("./push.service");

const TICK_MS = 60 * 1000;
const STUCK_AFTER_MS = 30 * 60 * 1000; // a campaign still 'sending' after this long was cut off by a restart

const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

/**
 * Who a campaign reaches: active (not blocked) customers matching the audience, and — for kind
 * `promotion` only — who haven't switched "Offers & news" off. `service` notices go to everyone targeted.
 * `filters` are the same ones as GET /admin/customers (min_orders, max_orders, inactive_days, ordered_category_id).
 * Returns { customerIds, matched, optedOutExcluded } where matched is the audience size before opt-outs.
 */
async function resolveAudience({ audience_type, filters, phones, kind }) {
  // Required lazily: adminCustomers pulls in the order controllers, which pull in this module's siblings.
  const { customersWithOrderStats, applyCampaignFilters } = require("../controllers/adminCustomers.controller");
  let rows;
  if (audience_type === "phones") {
    rows = [];
    for (let i = 0; i < phones.length; i += 1000) {
      rows.push(...(await db("users").where({ status: "active" }).whereIn("phone", phones.slice(i, i + 1000)).select("id", "notification_prefs")));
    }
  } else if (audience_type === "filtered") {
    const { query } = applyCampaignFilters(customersWithOrderStats(), filters || {}, { forceActiveOnly: true });
    rows = await query;
  } else {
    rows = await db("users").where({ status: "active" }).select("id", "notification_prefs");
  }
  const matched = rows.length;
  const reached = kind === "promotion" ? rows.filter((r) => promoOptIn(r.notification_prefs)) : rows;
  return { customerIds: reached.map((r) => r.id), matched, optedOutExcluded: matched - reached.length };
}

const audienceOf = (c) => ({ audience_type: c.audience_type, filters: parseJson(c.audience_filters, {}), phones: parseJson(c.audience_phones, []), kind: c.kind });

/** Sends a campaign that has already been claimed (status 'sending') and records the outcome on its row. Never throws. */
async function runCampaign(id) {
  const c = await db("notification_campaigns").where({ id }).first();
  if (!c || c.status !== "sending") return;
  try {
    const { customerIds } = await resolveAudience(audienceOf(c));
    await db("notification_campaigns").where({ id }).update({ targeted_customers: customerIds.length });
    const result = await sendToCustomerDevices(customerIds, { title: c.title, body: c.body, data: { type: "campaign", campaign_id: String(id), kind: c.kind } });
    const nothingDelivered = result.devices > 0 && result.sent === 0;
    await db("notification_campaigns").where({ id }).update({
      targeted_devices: result.devices, sent_count: result.sent, failed_count: result.failed,
      status: nothingDelivered ? "failed" : "sent",
      error: nothingDelivered ? "No device accepted the push (is FCM configured on the server?)" : null,
      sent_at: new Date(), updated_at: db.fn.now(),
    });
  } catch (err) {
    console.error(`[campaign] #${id} failed:`, err.message);
    await db("notification_campaigns").where({ id }).update({ status: "failed", error: String(err.message).slice(0, 500), sent_at: new Date(), updated_at: db.fn.now() }).catch(() => {});
  }
}

/** Atomically moves a scheduled campaign to 'sending'. False if someone else (the scheduler, a cancel) got there first. */
async function claim(id) {
  const n = await db("notification_campaigns").where({ id, status: "scheduled" }).update({ status: "sending", updated_at: db.fn.now() });
  return n === 1;
}

let processing = false;
/** Sends every scheduled campaign whose time has come, oldest first. Called every minute by the scheduler. */
async function processDue(now = new Date()) {
  if (processing) return 0;
  processing = true;
  let sent = 0;
  try {
    const due = await db("notification_campaigns").where({ status: "scheduled" }).andWhere("scheduled_at", "<=", now).orderBy("scheduled_at", "asc").limit(10).select("id");
    for (const { id } of due) {
      if (await claim(id)) { await runCampaign(id); sent += 1; }
    }
  } finally {
    processing = false;
  }
  return sent;
}

/** A campaign left 'sending' by a crash/restart is marked failed (not re-sent: some customers may already have it). */
async function failStuckCampaigns(now = new Date()) {
  return db("notification_campaigns").where({ status: "sending" }).andWhere("updated_at", "<", new Date(now.getTime() - STUCK_AFTER_MS))
    .update({ status: "failed", error: "Interrupted by a server restart; check how many devices got it before re-sending", updated_at: db.fn.now() });
}

let timer = null;
/** In-process scheduler: the API runs as a single PM2 instance, so a once-a-minute interval is enough. */
function startScheduler() {
  if (timer) return;
  failStuckCampaigns().catch((e) => console.error("[campaign] stuck-check failed:", e.message));
  timer = setInterval(() => processDue().catch((e) => console.error("[campaign] scheduler tick failed:", e.message)), TICK_MS);
  timer.unref(); // never keeps the process alive on its own
}

module.exports = { resolveAudience, runCampaign, claim, processDue, failStuckCampaigns, startScheduler, parseJson, TICK_MS };
