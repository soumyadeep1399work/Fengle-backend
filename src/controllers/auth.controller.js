const bcrypt = require("bcrypt");
const db = require("../config/db");
const { generateOtp, demoOtpFor, hashOtp, verifyOtpHash, getExpiryDate, MAX_ATTEMPTS } = require("../utils/otp");
const { sendOtpSms } = require("../utils/sms");
const { signToken } = require("../utils/jwt");

// Maps an OTP "purpose" to the table we look up / create the user record in.
const PURPOSE_TABLE = {
  login: "users",           // customer
  signup: "users",          // customer
  restaurant_login: "restaurants",
  rider_login: "riders",
};

/**
 * POST /auth/otp/request
 * body: { phone, purpose }
 */
async function requestOtp(req, res) {
  const { phone, purpose = "login" } = req.body;

  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: "A valid 10-digit phone number is required" });
  }
  if (!PURPOSE_TABLE[purpose]) {
    return res.status(400).json({ error: "Invalid purpose" });
  }

  const demoOtp = demoOtpFor(phone);
  const otp = demoOtp || generateOtp();
  const otpHash = await hashOtp(otp);

  await db("otp_verifications").insert({
    phone,
    otp_hash: otpHash,
    purpose,
    expires_at: getExpiryDate(),
  });

  // A demo phone's code is fixed and already known to whoever uses it, so
  // nothing is sent (or logged) for it.
  if (!demoOtp) {
    // Caught here (not left to reject) because Express 4 does not forward a
    // rejected async handler to the error middleware — an SMS provider outage
    // would otherwise be an unhandled rejection instead of a clean error.
    try {
      await sendOtpSms(phone, otp);
    } catch (err) {
      console.error(`[otp] SMS send failed for ${phone}:`, err.message);
      return res.status(502).json({ error: "Could not send the OTP right now. Please try again in a moment." });
    }
  }

  return res.json({ message: "OTP sent", expires_in_minutes: 5 });
}

/**
 * POST /auth/otp/verify
 * body: { phone, otp, purpose, name? }
 * On first-time login, a user/rider/restaurant record is created automatically (self-serve signup).
 */
async function verifyOtp(req, res) {
  const { phone, otp, purpose = "login", name } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: "phone and otp are required" });
  }

  const record = await db("otp_verifications")
    .where({ phone, purpose, verified: false })
    .orderBy("created_at", "desc")
    .first();

  if (!record) {
    return res.status(400).json({ error: "No pending OTP request for this number" });
  }
  if (new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: "OTP expired, please request a new one" });
  }
  if (record.attempt_count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many attempts, please request a new OTP" });
  }

  const isValid = await verifyOtpHash(otp, record.otp_hash);
  if (!isValid) {
    await db("otp_verifications").where({ id: record.id }).increment("attempt_count", 1);
    return res.status(400).json({ error: "Incorrect OTP" });
  }

  await db("otp_verifications").where({ id: record.id }).update({ verified: true });

  const table = PURPOSE_TABLE[purpose];
  const userType = table === "users" ? "customer" : table === "restaurants" ? "restaurant" : "rider";

  let userRow = await db(table).where({ phone }).first();

  if (!userRow && table === "restaurants") {
    // Restaurants are manually onboarded via Admin Panel only (confirmed business rule) —
    // an OTP verifying successfully for an unknown restaurant phone means it hasn't been
    // onboarded yet, not that we should create one on the fly.
    return res.status(404).json({ error: "This number is not registered as a partner restaurant. Please contact admin for onboarding." });
  }

  if (!userRow) {
    // Self-serve signup: first successful OTP verification creates the account.
    // Applies to customers and riders (confirmed: rider onboarding is self-serve).
    // A rider starts unverified: nothing but onboarding works until an admin approves the selfie.
    const [id] = await db(table).insert({ phone, name: name || null, ...(table === "riders" ? { verification_status: "pending" } : {}) });
    userRow = await db(table).where({ id }).first();
  }

  // Admin-imposed block: a blocked customer or a suspended rider/restaurant
  // must not be able to log back in (Admin Panel decision 2026-09-27). The
  // OTP itself is still consumed above — it just doesn't buy a session.
  const isBlocked = userType === "customer" ? userRow.status === "blocked" : userRow.status === "suspended";
  if (isBlocked) {
    return res.status(403).json({ error: "Your account has been suspended. Contact support." });
  }

  const token = signToken({ id: userRow.id, type: userType });

  return res.json({
    token,
    user: { id: userRow.id, phone: userRow.phone, name: userRow.name, type: userType },
  });
}

/**
 * POST /auth/admin/login
 * body: { email, password }
 *
 * Admins are never self-serve (same posture as restaurants — see CLAUDE.md).
 * There is no admin signup endpoint; accounts are created out-of-band via
 * `node scripts/create-admin.js`. Email+password rather than OTP because
 * admins aren't expected to be phone-first the way customers/riders are.
 */
async function adminLogin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const admin = await db("admins").where({ email }).first();
  if (!admin) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const isValid = await bcrypt.compare(password, admin.password_hash);
  if (!isValid) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (!admin.is_active) {
    return res.status(403).json({ error: "This account has been disabled. Ask a super admin to re-enable it.", code: "account_disabled" });
  }

  await db("admins").where({ id: admin.id }).update({ last_login_at: new Date() });
  const token = signToken({ id: admin.id, type: "admin" });

  return res.json({
    token,
    user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, type: "admin" },
  });
}

const AUTH_TABLE_BY_TYPE = { customer: "users", restaurant: "restaurants", rider: "riders", admin: "admins" };

/**
 * GET /auth/session
 * Lets the app validate a persisted token on boot and skip straight past
 * Splash/Onboarding/Phone/OTP if it's still good — requireAuth already
 * rejects a missing/expired/invalid token with 401 before this runs, so
 * reaching this handler at all means the session is valid.
 */
async function getSession(req, res) {
  const { id, type } = req.auth;
  const table = AUTH_TABLE_BY_TYPE[type];
  const row = await db(table).where({ id }).first();
  if (!row) return res.status(401).json({ error: "Account no longer exists" });

  if (type === "admin") {
    return res.json({ user: { id: row.id, name: row.name, email: row.email, role: row.role, type } });
  }
  return res.json({ user: { id: row.id, phone: row.phone, name: row.name, type } });
}

/**
 * POST /auth/logout
 * JWTs here are stateless (no server-side session/blocklist) — logout is
 * really the client discarding its token. This endpoint exists so the app
 * has a clean place to also deregister the device's push token, if it
 * sends one, rather than leaving stale device_tokens rows behind.
 * body: { device_token? }
 */
async function logout(req, res) {
  const { device_token } = req.body;
  if (device_token) {
    await db("device_tokens").where({ owner_type: req.auth.type, owner_id: req.auth.id, token: device_token }).delete();
  }
  res.json({ message: "Logged out" });
}

module.exports = { requestOtp, verifyOtp, adminLogin, getSession, logout };
