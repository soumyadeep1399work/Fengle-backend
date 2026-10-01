// Thin abstraction so swapping MSG91 <-> Fast2SMS <-> Twilio later is a one-file change,
// not a refactor across every place that sends an OTP.

/**
 * @param {string} phone - E.164 or 10-digit Indian mobile number
 * @param {string} otp
 */
// Last OTP per phone, kept in memory so GET /api/v1/dev/last-otp can read it
// without needing the server's console. TEMPORARY (2026-10-01): now populated
// in every environment, including production, per the same user-approved
// exception as otpLookup.routes.js — was previously dev-only. Capped at
// MAX_ENTRIES (oldest evicted first) since it's otherwise never evicted and
// production now has a real, growing user base — unbounded growth would be
// a real memory leak on this box's 1GB RAM, not just a theoretical one.
const lastDevOtps = new Map();
const MAX_DEV_OTP_ENTRIES = 1000;

function getLastDevOtp(phone) {
  return lastDevOtps.get(phone) || null;
}

function rememberOtp(phone, otp) {
  lastDevOtps.delete(phone); // re-insert so this phone becomes the newest for eviction order
  lastDevOtps.set(phone, { otp, requestedAt: new Date().toISOString() });
  if (lastDevOtps.size > MAX_DEV_OTP_ENTRIES) {
    lastDevOtps.delete(lastDevOtps.keys().next().value); // evict the oldest
  }
}

/**
 * Whether to actually send is decided purely by "is a real provider
 * configured", NOT by NODE_ENV. A production deploy without MSG91 keys set
 * yet (the real state of this project before go-live) must degrade to
 * logging the OTP server-side, not hard-fail every login — this used to be
 * gated on NODE_ENV !== "production", which crashed POST /auth/otp/request
 * outright whenever NODE_ENV was correctly set to "production" with no SMS
 * provider configured (found 2026-10-01, during pre-launch testing).
 */
async function sendOtpSms(phone, otp) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;

  if (!authKey || !templateId) {
    console.log(`[otp] no SMS provider configured — OTP for ${phone}: ${otp}`);
    rememberOtp(phone, otp);
    return { success: true, dev: true };
  }

  const url = `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=91${phone}&authkey=${authKey}&otp=${otp}`;

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`MSG91 request failed: ${res.status}`);
  }
  return res.json();
}

module.exports = { sendOtpSms, getLastDevOtp };
