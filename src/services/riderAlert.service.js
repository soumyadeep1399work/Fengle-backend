const db = require("../config/db");
const orderPush = require("./orderNotifications.service");

/**
 * The rider's new-delivery alarm keeps going until the rider reacts — the twin of kitchenAlert.service.js. The first push is sent when
 * the order is assigned (orderNotifications.riderAssigned, which stamps rider_notified_at); this module sends the REMINDERS: every
 * tick, an order still 'accepted' (assigned, not picked up) whose rider hasn't acknowledged gets the same loud push again once
 * RIDER_REMINDER_INTERVAL_SECONDS (default 30) have passed since the last push, up to RIDER_MAX_REMINDERS (default 10) times. It stops
 * when the rider acknowledges ("View assignment" -> POST /orders/:id/rider-acknowledge) or picks the order up, when the order is
 * cancelled, and when it is given to another rider (the reset on reassignment clears rider_notified_at, so the old rider's alert ends
 * and the new one starts from zero). Single PM2 instance: a plain in-process timer is enough.
 */

const TICK_MS = 15 * 1000;

function intervalSeconds() {
  const n = Number(process.env.RIDER_REMINDER_INTERVAL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function maxReminders() {
  const raw = process.env.RIDER_MAX_REMINDERS;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0 ? n : 10;
}

/** Sends every reminder that is due. Returns the order ids reminded. */
async function remindDue(now = new Date()) {
  const cutoff = new Date(now.getTime() - intervalSeconds() * 1000);
  const max = maxReminders();
  const due = await db("orders")
    .where({ status: "accepted" })
    .whereNotNull("rider_id")
    .whereNull("rider_acknowledged_at")
    .whereNotNull("rider_notified_at")
    .where("rider_reminders_sent", "<", max)
    .whereRaw("COALESCE(rider_last_reminder_at, rider_notified_at) <= ?", [cutoff])
    .select("id", "rider_id", "rider_reminders_sent");

  const reminded = [];
  for (const o of due) {
    // Claim the slot first with a conditional write, so an overlapping tick (or a reassignment mid-way) can never double-remind.
    const claimed = await db("orders")
      .where({ id: o.id, status: "accepted", rider_id: o.rider_id, rider_reminders_sent: o.rider_reminders_sent })
      .whereNull("rider_acknowledged_at")
      .update({ rider_reminders_sent: o.rider_reminders_sent + 1, rider_last_reminder_at: now });
    if (claimed !== 1) continue;
    try {
      await orderPush.riderAssigned(o.id, { reminder: true });
    } catch (err) {
      console.error(`[rider-alert] reminder for order ${o.id} failed:`, err.message);
    }
    reminded.push(o.id);
  }
  return reminded;
}

let timer = null;
/** Started from server.js (not app.js) so tests never run it. */
function startTick() {
  if (timer) return;
  timer = setInterval(() => { remindDue().catch((err) => console.error("[rider-alert] tick failed:", err.message)); }, TICK_MS);
  timer.unref();
}

module.exports = { remindDue, startTick, TICK_MS, intervalSeconds, maxReminders };
