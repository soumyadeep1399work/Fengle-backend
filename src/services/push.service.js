// Push notifications, sent straight to Firebase Cloud Messaging (HTTP v1 API)
// with the project's service account — the apps register their native FCM
// token. No Firebase SDK: the OAuth token is a JWT signed with Node's crypto,
// so there's no extra dependency on the 1 GB instance.
//
// Tokens in Expo's format (ExponentPushToken[...]) still go through the Expo
// Push Service, so either kind of token can be stored in device_tokens.
//
// Everything here is best-effort: callers use notifyLater(), so a push failure
// is logged and never fails or slows the API request that triggered it.
const crypto = require("crypto");
const fs = require("fs");
const db = require("../config/db");

const CHANNEL_ID = "orders"; // must match the Android channel the apps create
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_MAX_BATCH = 100;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const isExpoToken = (token) => token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[");

async function deleteTokens(tokens) {
  if (tokens.length) await db("device_tokens").whereIn("token", tokens).delete();
}

// ---------------------------------------------------------------------------
// FCM HTTP v1
// ---------------------------------------------------------------------------

let serviceAccount; // { project_id, client_email, private_key }, loaded once
function getServiceAccount() {
  if (serviceAccount === undefined) {
    const file = process.env.FCM_SERVICE_ACCOUNT_FILE;
    serviceAccount = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (!serviceAccount) console.warn("[push] FCM_SERVICE_ACCOUNT_FILE not set — FCM pushes are skipped");
  }
  return serviceAccount;
}

const base64url = (input) => Buffer.from(input).toString("base64url");

let cachedAccessToken = null; // { token, expiresAt }
async function getAccessToken(sa) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: sa.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key, "base64url");

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) throw new Error(`FCM auth failed (${res.status}): ${payload.error_description || payload.error || "no token"}`);

  cachedAccessToken = { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
  return cachedAccessToken.token;
}

// FCM says the token will never work again (app uninstalled, data cleared) or
// isn't a token at all.
function isDeadTokenError(status, error) {
  const codes = ((error && error.details) || []).map((d) => d.errorCode);
  if (status === 404 || codes.includes("UNREGISTERED")) return true;
  return status === 400 && /registration token/i.test((error && error.message) || "");
}

async function sendFcm(tokens, { title, body, data }) {
  const sa = getServiceAccount();
  if (!sa || !tokens.length) return;
  const accessToken = await getAccessToken(sa);
  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  // FCM data values must be strings.
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));

  const dead = [];
  await Promise.all(
    tokens.map(async (token) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: stringData,
            android: { priority: "HIGH", notification: { channel_id: CHANNEL_ID, sound: "default" } },
          },
        }),
      });
      if (res.ok) return;
      const { error } = await res.json().catch(() => ({}));
      if (isDeadTokenError(res.status, error)) dead.push(token);
      else console.error("[push] FCM send failed", res.status, error && error.message);
    })
  );
  await deleteTokens(dead);
}

// ---------------------------------------------------------------------------
// Expo Push Service (for Expo-format tokens)
// ---------------------------------------------------------------------------

async function sendExpo(tokens, { title, body, data }) {
  const messages = tokens.map((to) => ({ to, title, body, data, channelId: CHANNEL_ID, sound: "default", priority: "high" }));
  for (let i = 0; i < messages.length; i += EXPO_MAX_BATCH) {
    const batch = messages.slice(i, i + EXPO_MAX_BATCH);
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

    const res = await fetch(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(batch) });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || !Array.isArray(payload.data)) {
      console.error("[push] Expo push request failed", res.status, payload && payload.errors);
      continue;
    }

    // Tickets come back in message order.
    const dead = [];
    payload.data.forEach((ticket, idx) => {
      if (ticket.status !== "error") return;
      if (ticket.details && ticket.details.error === "DeviceNotRegistered") dead.push(batch[idx].to);
      else console.error("[push] Expo ticket error", ticket.message);
    });
    await deleteTokens(dead);
  }
}

// ---------------------------------------------------------------------------

// Customers can switch order updates off in the app; riders and kitchens can't
// (their pushes are how they learn about work).
async function customerWantsOrderUpdates(customerId) {
  const user = await db("users").where({ id: customerId }).select("notification_prefs").first();
  if (!user || !user.notification_prefs) return true;
  const prefs = typeof user.notification_prefs === "string" ? JSON.parse(user.notification_prefs) : user.notification_prefs;
  return prefs.order_updates !== false;
}

/**
 * notification_prefs.promotions === false is the only opt-OUT signal;
 * unset/true/null means opted in. A different toggle from order_updates
 * above — this one gates promotional pushes (coupons), not order status.
 */
function promoOptIn(notificationPrefsRaw) {
  if (!notificationPrefsRaw) return true;
  const prefs = typeof notificationPrefsRaw === "string" ? JSON.parse(notificationPrefsRaw) : notificationPrefsRaw;
  return prefs.promotions !== false;
}

/**
 * Broadcasts one notification to every device belonging to the given
 * customer ids, skipping anyone who's turned "Offers & news" off. Used for
 * coupon-creation pushes — order-update pushes go through sendToOwner()'s
 * own (different) preference check, never this one.
 */
async function sendPromoBroadcast(customerIds, { title, body, data = {} }) {
  if (!customerIds.length) return;
  const customers = await db("users").whereIn("id", customerIds).select("id", "notification_prefs");
  const optedIn = customers.filter((c) => promoOptIn(c.notification_prefs)).map((c) => c.id);
  if (!optedIn.length) return;

  const rows = await db("device_tokens").where({ owner_type: "customer" }).whereIn("owner_id", optedIn).select("token");
  const tokens = rows.map((r) => r.token);
  if (!tokens.length) return;

  const notification = { title, body, data };
  await Promise.all([
    sendFcm(tokens.filter((t) => !isExpoToken(t)), notification),
    sendExpo(tokens.filter(isExpoToken), notification),
  ]);
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

  const rows = await db("device_tokens").where({ owner_type: ownerType, owner_id: ownerId }).select("token");
  const tokens = rows.map((r) => r.token);
  if (!tokens.length) return;

  const notification = { title, body, data };
  await Promise.all([
    sendFcm(tokens.filter((t) => !isExpoToken(t)), notification),
    sendExpo(tokens.filter(isExpoToken), notification),
  ]);
}

/** Run a push job after the current request finishes; errors are only logged. */
function notifyLater(job) {
  setImmediate(() => {
    Promise.resolve()
      .then(job)
      .catch((err) => console.error("[push] notification failed:", err.message));
  });
}

module.exports = { sendToOwner, notifyLater, CHANNEL_ID, promoOptIn, sendPromoBroadcast };
