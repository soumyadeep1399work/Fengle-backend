// Thin abstraction so swapping Fast2SMS <-> MSG91 <-> Twilio later is a one-file change,
// not a refactor across every place that sends an OTP.

/**
 * @param {string} phone - E.164 or 10-digit Indian mobile number
 * @param {string} otp
 */
// Last OTP per phone, kept in memory so the dev-only GET /api/v1/dev/last-otp
// can read it without needing the server's console. Never populated in
// production (rememberOtp is a no-op there) — an OTP must not outlive its SMS.
// Capped at MAX_DEV_OTP_ENTRIES (oldest evicted first) so it can't grow forever.
const lastDevOtps = new Map();
const MAX_DEV_OTP_ENTRIES = 1000;

function getLastDevOtp(phone) {
  return lastDevOtps.get(phone) || null;
}

function rememberOtp(phone, otp) {
  if (process.env.NODE_ENV === "production") return;
  lastDevOtps.delete(phone); // re-insert so this phone becomes the newest for eviction order
  lastDevOtps.set(phone, { otp, requestedAt: new Date().toISOString() });
  if (lastDevOtps.size > MAX_DEV_OTP_ENTRIES) {
    lastDevOtps.delete(lastDevOtps.keys().next().value); // evict the oldest
  }
}

const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";
const FAST2SMS_TIMEOUT_MS = 10000;

/**
 * Whether to actually send is decided purely by "is a real provider
 * configured", NOT by NODE_ENV. A production deploy without Fast2SMS keys set
 * yet (the real state of this project before go-live) must degrade to
 * logging the OTP server-side, not hard-fail every login — this used to be
 * gated on NODE_ENV !== "production", which crashed POST /auth/otp/request
 * outright whenever NODE_ENV was correctly set to "production" with no SMS
 * provider configured (found 2026-10-01, during pre-launch testing).
 */
async function sendOtpSms(phone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const senderId = process.env.FAST2SMS_SENDER_ID;
  const messageId = process.env.FAST2SMS_MESSAGE_ID;

  if (!apiKey || !senderId || !messageId) {
    console.log(`[otp] no SMS provider configured — OTP for ${phone}: ${otp}`);
    rememberOtp(phone, otp);
    return { success: true, dev: true };
  }

  // Fast2SMS "DLT SMS" route: `message` is the Message ID that Fast2SMS's DLT
  // Manager gives the approved template (NOT the operator's DLT template ID),
  // and the template's single {#var#} is the OTP.
  const res = await fetch(FAST2SMS_URL, {
    method: "POST",
    headers: { authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      route: "dlt",
      sender_id: senderId,
      message: messageId,
      variables_values: otp,
      numbers: phone,
    }),
    signal: AbortSignal.timeout(FAST2SMS_TIMEOUT_MS),
  });

  // Failures come back as JSON ({ return: false, status_code, message }) with
  // a 4xx status, so read the body before deciding.
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.return !== true) {
    const reason = body ? `${body.status_code ?? res.status} ${[].concat(body.message ?? "").join(" ")}` : `HTTP ${res.status}`;
    throw new Error(`Fast2SMS send failed: ${reason.trim()}`);
  }
  return body;
}

module.exports = { sendOtpSms, getLastDevOtp };
