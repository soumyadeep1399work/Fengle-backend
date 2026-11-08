const db = require("../config/db");
const { CUSTOMER_TERMS_VERSION, customerAgreementRequired } = require("../utils/customerTerms");
const { issueOtp, checkOtp } = require("../services/otpDelivery.service");

const DEFAULT_NOTIFICATION_PREFS = { order_updates: true, promotions: true };

function serializeProfile(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    photo_url: row.photo_url,
    veg_only: Boolean(row.veg_only),
    wallet_balance: Number(row.wallet_balance),
    notification_prefs: row.notification_prefs
      ? (typeof row.notification_prefs === "string" ? JSON.parse(row.notification_prefs) : row.notification_prefs)
      : DEFAULT_NOTIFICATION_PREFS,
    agreementRequired: customerAgreementRequired(row),
  };
}

async function getMyProfile(req, res) {
  const row = await db("users").where({ id: req.auth.id }).first();
  if (!row) return res.status(404).json({ error: "Profile not found" });
  res.json({ profile: serializeProfile(row) });
}

/**
 * PATCH /profile/me
 * body: any of { name, email, photo_url }
 * Phone is intentionally not editable here — it's the OTP login identity.
 */
async function updateMyProfile(req, res) {
  const { name, email, photo_url } = req.body;
  const updates = {};
  if (name != null) updates.name = name;
  if (email != null) updates.email = email;
  if (photo_url != null) updates.photo_url = photo_url;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  await db("users").where({ id: req.auth.id }).update(updates);
  const row = await db("users").where({ id: req.auth.id }).first();
  res.json({ profile: serializeProfile(row) });
}

const PHONE_TAKEN = "This number is already used by another Fengle account.";
const isPhone = (v) => typeof v === "string" && /^\d{10}$/.test(v); // same rule as login

/**
 * POST /profile/phone/request-change { phone } -> 200 { message, expires_in_minutes }
 * Step 1 of changing the number a customer logs in with: an OTP goes to the NEW number (proof they own it). 400 for an invalid
 * number or their current one, 409 if another customer already has it (the only thing revealed about other accounts), 429 on the
 * shared per-phone SMS limits or this customer's own hourly cap (PHONE_CHANGE_MAX_PER_HOUR, default 5).
 */
async function requestPhoneChange(req, res) {
  const { phone } = req.body || {};
  if (!isPhone(phone)) return res.status(400).json({ error: "A valid 10-digit phone number is required" });
  const me = await db("users").where({ id: req.auth.id }).select("phone").first();
  if (!me) return res.status(404).json({ error: "Profile not found" });
  if (me.phone === phone) return res.status(400).json({ error: "That is already your number" });
  if (await db("users").where({ phone }).first("id")) return res.status(409).json({ error: PHONE_TAKEN });

  const perHour = Number(process.env.PHONE_CHANGE_MAX_PER_HOUR ?? 5);
  const mine = await db("otp_verifications").where({ purpose: "phone_change", owner_id: req.auth.id }).whereRaw("created_at > (NOW() - INTERVAL 1 HOUR)").count({ n: "id" }).first();
  if (Number(mine.n) >= perHour) return res.status(429).json({ error: "Too many attempts to change your number. Please try again in an hour." });

  const issued = await issueOtp({ phone, purpose: "phone_change", ownerId: req.auth.id });
  if (issued.error) return res.status(issued.status).json({ error: issued.error });
  res.json({ message: "OTP sent", expires_in_minutes: 5 });
}

/**
 * POST /profile/phone/verify-change { phone, otp } -> 200 { profile }
 * Step 2: the code sent to the new number. Updates users.phone, writes phone_change_history (old -> new) and consumes the code.
 * The session token identifies the customer by id, so it stays valid and no new token is issued. 400 wrong/expired code,
 * 409 if the number was taken in the meantime (the users.phone unique key decides races).
 */
async function verifyPhoneChange(req, res) {
  const { phone, otp } = req.body || {};
  if (!isPhone(phone) || !otp) return res.status(400).json({ error: "phone and otp are required" });
  const checked = await checkOtp({ phone, purpose: "phone_change", otp, ownerId: req.auth.id });
  if (checked.error) return res.status(checked.status).json({ error: checked.error });

  try {
    await db.transaction(async (trx) => {
      const me = await trx("users").where({ id: req.auth.id }).forUpdate().first();
      if (!me) throw Object.assign(new Error("Profile not found"), { status: 404 });
      if (me.phone !== phone) {
        await trx("users").where({ id: req.auth.id }).update({ phone });
        await trx("phone_change_history").insert({ customer_id: req.auth.id, old_phone: me.phone, new_phone: phone });
      }
      await trx("otp_verifications").where({ purpose: "phone_change", owner_id: req.auth.id, verified: false }).update({ verified: true });
    });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: PHONE_TAKEN });
    throw err;
  }
  const row = await db("users").where({ id: req.auth.id }).first();
  res.json({ profile: serializeProfile(row) });
}

/**
 * PATCH /profile/preferences
 * body: { veg_only }
 */
async function updatePreferences(req, res) {
  const { veg_only } = req.body;
  if (veg_only == null) {
    return res.status(400).json({ error: "veg_only is required" });
  }
  await db("users").where({ id: req.auth.id }).update({ veg_only: Boolean(veg_only) });
  const row = await db("users").where({ id: req.auth.id }).first();
  res.json({ profile: serializeProfile(row) });
}

/**
 * PATCH /profile/default-address
 * body: { address_id }
 * Thin alias over the address CRUD's own is_default flip (PATCH
 * /addresses/:id already does this) — kept as its own route since the
 * Customer App's profile screen models "default address" as a profile
 * action, not an address-editing one.
 */
async function setDefaultAddress(req, res) {
  const { address_id } = req.body;
  if (!address_id) return res.status(400).json({ error: "address_id is required" });

  const address = await db("addresses").where({ id: address_id, customer_id: req.auth.id }).first();
  if (!address) return res.status(404).json({ error: "Address not found" });

  await db.transaction(async (trx) => {
    await trx("addresses").where({ customer_id: req.auth.id }).update({ is_default: false });
    await trx("addresses").where({ id: address_id }).update({ is_default: true });
  });

  const addresses = await db("addresses").where({ customer_id: req.auth.id }).orderBy([{ column: "is_default", order: "desc" }, { column: "created_at", order: "asc" }]);
  res.json({ addresses });
}

/**
 * POST /profile/accept-agreement
 * body: { agreement_version }
 * The Customer app's one-time T&C popup — no file upload, unlike the
 * restaurant/rider agreement+selfie feature. 409 if the version the app is
 * showing is stale, so an old build can't accept an outdated version.
 * agreement_accepted_at is always the server's own clock.
 */
async function acceptAgreement(req, res) {
  const version = Number(req.body.agreement_version);
  if (!Number.isInteger(version)) {
    return res.status(400).json({ error: "agreement_version is required and must be an integer" });
  }
  if (version !== CUSTOMER_TERMS_VERSION) {
    return res.status(409).json({ error: `agreement_version mismatch — current version is ${CUSTOMER_TERMS_VERSION}` });
  }

  const acceptedAt = new Date();
  await db("users").where({ id: req.auth.id }).update({
    agreement_accepted_at: acceptedAt,
    agreement_version: version,
  });

  res.json({ agreementAcceptedAt: acceptedAt.toISOString() });
}

module.exports = { getMyProfile, updateMyProfile, requestPhoneChange, verifyPhoneChange, updatePreferences, setDefaultAddress, acceptAgreement };
