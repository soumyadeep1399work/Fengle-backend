// Push notifications via the Expo Push Service, which delivers through FCM on
// Android (and APNs on iOS later) using the FCM V1 key uploaded to EAS — the
// backend never talks to Firebase directly and needs no SDK (plain fetch, so no
// extra memory on the 1 GB instance).
//
// Everything here is best-effort: callers use notifyLater(), so a push failure
// is logged and never fails or slows the API request that triggered it.
const db = require("../config/db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHANNEL_ID = "orders"; // must match the Android channel the apps create
const MAX_BATCH = 100; // Expo's per-request message limit

async function tokensFor(ownerType, ownerId) {
  const rows = await db("device_tokens").where({ owner_type: ownerType, owner_id: ownerId }).select("token");
  return rows.map((r) => r.token);
}

// Customers can switch order updates off in the app; riders and kitchens can't
// (their pushes are how they learn about work).
async function customerWantsOrderUpdates(customerId) {
  const user = await db("users").where({ id: customerId }).select("notification_prefs").first();
  if (!user || !user.notification_prefs) return true;
  const prefs = typeof user.notification_prefs === "string" ? JSON.parse(user.notification_prefs) : user.notification_prefs;
  return prefs.order_updates !== false;
}

async function sendMessages(messages) {
  for (let i = 0; i < messages.length; i += MAX_BATCH) {
    const batch = messages.slice(i, i + MAX_BATCH);
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

    const res = await fetch(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(batch) });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || !Array.isArray(payload.data)) {
      console.error("[push] Expo push request failed", res.status, payload && payload.errors);
      continue;
    }

    // Tickets come back in message order. A token the device has dropped
    // (app uninstalled, data cleared) will never work again — remove it.
    const dead = [];
    payload.data.forEach((ticket, idx) => {
      if (ticket.status !== "error") return;
      if (ticket.details && ticket.details.error === "DeviceNotRegistered") dead.push(batch[idx].to);
      else console.error("[push] ticket error", ticket.message);
    });
    if (dead.length) await db("device_tokens").whereIn("token", dead).delete();
  }
}

/**
 * Send one notification to every device registered to an account.
 * @param {'customer'|'restaurant'|'rider'} ownerType
 * @param {number} ownerId
 * @param {{ title: string, body: string, data?: object }} notification
 */
async function sendToOwner(ownerType, ownerId, { title, body, data = {} }) {
  if (!ownerId) return;
  if (ownerType === "customer" && !(await customerWantsOrderUpdates(ownerId))) return;

  const tokens = await tokensFor(ownerType, ownerId);
  if (!tokens.length) return;

  await sendMessages(
    tokens.map((to) => ({ to, title, body, data, channelId: CHANNEL_ID, sound: "default", priority: "high" }))
  );
}

/** Run a push job after the current request finishes; errors are only logged. */
function notifyLater(job) {
  setImmediate(() => {
    Promise.resolve()
      .then(job)
      .catch((err) => console.error("[push] notification failed:", err.message));
  });
}

module.exports = { sendToOwner, notifyLater, CHANNEL_ID };
