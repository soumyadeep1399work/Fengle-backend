// Thin abstraction so swapping MSG91 <-> Fast2SMS <-> Twilio later is a one-file change,
// not a refactor across every place that sends an OTP.

/**
 * @param {string} phone - E.164 or 10-digit Indian mobile number
 * @param {string} otp
 */
// Dev only: last OTP per phone, kept in memory so testers (or another
// process, via GET /api/v1/dev/last-otp) can read it without needing the
// server's console. Never populated in production — see the branch below.
const lastDevOtps = new Map();

function getLastDevOtp(phone) {
  return lastDevOtps.get(phone) || null;
}

async function sendOtpSms(phone, otp) {
  if (process.env.NODE_ENV !== "production") {
    // Never actually send in dev — log instead so local testing doesn't burn SMS credits.
    console.log(`[dev-sms] OTP for ${phone}: ${otp}`);
    lastDevOtps.set(phone, { otp, requestedAt: new Date().toISOString() });
    return { success: true, dev: true };
  }

  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authKey || !templateId) {
    throw new Error("MSG91_AUTH_KEY / MSG91_TEMPLATE_ID not configured");
  }

  const url = `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=91${phone}&authkey=${authKey}&otp=${otp}`;

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`MSG91 request failed: ${res.status}`);
  }
  return res.json();
}

module.exports = { sendOtpSms, getLastDevOtp };
