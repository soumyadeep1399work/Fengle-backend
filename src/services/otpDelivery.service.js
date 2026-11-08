const db = require("../config/db");
const { generateOtp, demoOtpFor, hashOtp, verifyOtpHash, getExpiryDate, MAX_ATTEMPTS } = require("../utils/otp");
const { sendOtpSms } = require("../utils/sms");

/**
 * Issuing and checking OTPs, shared by the login flow (auth.controller) and the change-phone flow (profile.controller) so both obey
 * the same per-phone limits. Every function returns { error, status } for the caller to send, or a result.
 */

/**
 * Per-PHONE limits (the per-IP ones can't stop someone rotating IPs against one victim's number): a cooldown between codes and an
 * hourly cap. Each code costs an SMS, and each fresh code resets the 5-guess limit, so unlimited requests would also let an
 * attacker keep guessing a 6-digit code. Counted from otp_verifications so it survives a restart. Demo phones are exempt (no SMS is
 * sent for them). Limits are read from env on each call.
 */
async function checkPhoneThrottle(phone) {
  const cooldown = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 30);
  const perHour = Number(process.env.OTP_MAX_REQUESTS_PER_HOUR ?? 6);
  const recent = await db("otp_verifications").where({ phone }).whereRaw("created_at > (NOW() - INTERVAL 1 HOUR)").count({ n: "id" }).first();
  if (Number(recent.n) >= perHour) return { status: 429, error: "Too many OTP requests for this number. Please try again in an hour." };
  if (cooldown > 0) {
    const last = await db("otp_verifications").where({ phone }).whereRaw("created_at > (NOW() - INTERVAL ? SECOND)", [cooldown]).first("id");
    if (last) return { status: 429, error: `Please wait ${cooldown} seconds before requesting another OTP.` };
  }
  return null;
}

/** Stores a fresh code for `phone` and texts it. `ownerId` ties a phone_change code to the customer who asked. */
async function issueOtp({ phone, purpose, ownerId = null }) {
  const demoOtp = demoOtpFor(phone);
  if (!demoOtp) {
    const blocked = await checkPhoneThrottle(phone);
    if (blocked) return blocked;
  }

  const otp = demoOtp || generateOtp();
  await db("otp_verifications").insert({ phone, otp_hash: await hashOtp(otp), purpose, owner_id: ownerId, expires_at: getExpiryDate() });

  // A demo phone's code is fixed and already known to whoever uses it, so nothing is sent (or logged) for it.
  if (!demoOtp) {
    // Caught here (not left to reject) because Express 4 does not forward a rejected async handler to the error middleware.
    try {
      await sendOtpSms(phone, otp);
    } catch (err) {
      console.error(`[otp] SMS send failed for ${phone}:`, err.message);
      return { status: 502, error: "Could not send the OTP right now. Please try again in a moment." };
    }
  }
  return { ok: true };
}

/** Checks a code against the newest pending one for phone + purpose (+ owner). Marks nothing: the caller consumes it on success. */
async function checkOtp({ phone, purpose, otp, ownerId = null }) {
  const record = await db("otp_verifications")
    .where({ phone, purpose, verified: false })
    .modify((qb) => { if (ownerId !== null) qb.where({ owner_id: ownerId }); })
    .orderBy("created_at", "desc")
    .orderBy("id", "desc") // two codes in the same second: the later one
    .first();
  if (!record) return { status: 400, error: "No pending OTP request for this number" };
  if (new Date(record.expires_at) < new Date()) return { status: 400, error: "OTP expired, please request a new one" };
  if (record.attempt_count >= MAX_ATTEMPTS) return { status: 429, error: "Too many attempts, please request a new OTP" };
  if (!(await verifyOtpHash(otp, record.otp_hash))) {
    await db("otp_verifications").where({ id: record.id }).increment("attempt_count", 1);
    return { status: 400, error: "Incorrect OTP" };
  }
  return { record };
}

module.exports = { issueOtp, checkOtp, checkPhoneThrottle };
