const db = require("../config/db");
const orderPush = require("./orderNotifications.service");

/**
 * The kitchen's new-order alarm keeps going until somebody reacts. A new order pushes once (orderNotifications.newOrderForRestaurant,
 * which stamps kitchen_notified_at); this module sends the REMINDERS: every REMINDER tick, an order still 'placed', visible to the
 * kitchen and not yet acknowledged gets the same loud push again once KITCHEN_REMINDER_INTERVAL_SECONDS (default 30) have passed
 * since the last push, up to KITCHEN_MAX_REMINDERS (default 10) times. It stops the moment the order is acknowledged (the app's
 * "Stop alarm" -> POST /orders/:id/acknowledge), accepted, rejected, cancelled or re-routed (all of which set kitchen_acknowledged_at
 * or move it out of 'placed'). The API runs as one PM2 instance, so a plain in-process timer is enough (like riderDispatch / campaigns).
 */

const TICK_MS = 15 * 1000;

function intervalSeconds() {
  const n = Number(process.env.KITCHEN_REMINDER_INTERVAL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function maxReminders() {
  const raw = process.env.KITCHEN_MAX_REMINDERS;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0 ? n : 10;
}

/** Sends every reminder that is due. Returns the order ids reminded. */
async function remindDue(now = new Date()) {
  const cutoff = new Date(now.getTime() - intervalSeconds() * 1000);
  const max = maxReminders();
  const due = await db("orders")
    .where({ status: "placed" })
    .whereNull("kitchen_acknowledged_at")
    .whereNotNull("kitchen_notified_at")
    .where((qb) => qb.where("payment_method", "cod").orWhere("payment_status", "paid")) // only orders the kitchen can see
    .where("kitchen_reminders_sent", "<", max)
    .whereRaw("COALESCE(kitchen_last_reminder_at, kitchen_notified_at) <= ?", [cutoff])
    .select("id", "kitchen_reminders_sent");

  const reminded = [];
  for (const o of due) {
    // Claim it first with a conditional write, so a slow send or an overlapping tick can never remind twice for the same slot.
    const claimed = await db("orders")
      .where({ id: o.id, status: "placed", kitchen_reminders_sent: o.kitchen_reminders_sent })
      .whereNull("kitchen_acknowledged_at")
      .update({ kitchen_reminders_sent: o.kitchen_reminders_sent + 1, kitchen_last_reminder_at: now });
    if (claimed !== 1) continue;
    try {
      await orderPush.newOrderForRestaurant(o.id, { reminder: true });
    } catch (err) {
      console.error(`[kitchen-alert] reminder for order ${o.id} failed:`, err.message);
    }
    reminded.push(o.id);
  }
  return reminded;
}

let timer = null;
/** Started from server.js (not app.js) so tests never run it. */
function startTick() {
  if (timer) return;
  timer = setInterval(() => { remindDue().catch((err) => console.error("[kitchen-alert] tick failed:", err.message)); }, TICK_MS);
  timer.unref();
}

module.exports = { remindDue, startTick, TICK_MS, intervalSeconds, maxReminders };
