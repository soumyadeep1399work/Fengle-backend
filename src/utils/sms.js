// Thin abstraction so swapping MSG91 <-> Fast2SMS <-> Twilio later is a one-file change,
// not a refactor across every place that sends an OTP.

/**
 * @param {string} phone - E.164 or 10-digit Indian mobile number
 * @param {string} otp
 */
// Dev only: last OTP per phone, kept in memory so testers (or another
// process, via GET /api/v1/dev/last-otp) can read it without needing the
// server's console. Only populated outside production — unlike the
// always-log-to-stdout fallback below, this Map is never evicted/bounded, so
// populating it in production (a real, growing user base) would be an
// unbounded memory leak on a RAM-constrained box. The /dev/last-otp route
// itself is also unmounted entirely in production (routes/index.js), so this
// is defense in depth, not the only thing keeping it private.
const lastDevOtps = new Map();

function getLastDevOtp(phone) {
  return lastDevOtps.get(phone) || null;
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
    if (process.env.NODE_ENV !== "production") {
      lastDevOtps.set(phone, { otp, requestedAt: new Date().toISOString() });
    }
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
