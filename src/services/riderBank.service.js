const crypto = require("crypto");
const db = require("../config/db");
const { sendToOwner, notifyLater } = require("./push.service");

/**
 * Rider payout account. The account number is encrypted at rest with AES-256-GCM (key: BANK_DATA_KEY, 32 bytes as 64 hex chars or
 * base64). There is deliberately NO plaintext fallback: without the key a save is refused (503). Only the last 4 digits are kept in
 * the clear, for the masked view. The full number is never logged and only ever leaves this module for super_admin / ops reads.
 */

class BankError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function getKey() {
  const raw = process.env.BANK_DATA_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function encrypt(plain) {
  const key = getKey();
  if (!key) throw new BankError(503, "Bank details can't be saved on this server yet", "bank_details_unavailable");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

/** Returns the plain text, or null if the key is missing/wrong (a rotated or lost key must not crash a read). */
function decrypt(stored) {
  const key = getKey();
  if (!key || !stored) return null;
  try {
    const [iv, tag, enc] = String(stored).split(".").map((p) => Buffer.from(p, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const UPI_RE = /^[\w.\-]{2,256}@[A-Za-z]{2,64}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Validates the rider's form. Returns { error } or { value } (cleaned). */
function validateInput(body) {
  const b = body || {};
  const holder = typeof b.account_holder_name === "string" ? b.account_holder_name.trim() : "";
  if (holder.length < 2 || holder.length > 100) return { error: "Account holder name must be 2 to 100 characters" };

  const numberRaw = typeof b.account_number === "string" || typeof b.account_number === "number" ? String(b.account_number).replace(/[\s-]/g, "") : "";
  if (!/^\d{9,18}$/.test(numberRaw)) return { error: "Account number must be 9 to 18 digits" };

  const ifsc = typeof b.ifsc === "string" ? b.ifsc.trim().toUpperCase() : "";
  if (!IFSC_RE.test(ifsc)) return { error: "IFSC must look like HDFC0001234 (4 letters, a 0, then 6 letters or digits)" };

  const optional = (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : v);
  const bankRaw = optional(b.bank_name);
  if (bankRaw !== null && (typeof bankRaw !== "string" || bankRaw.trim().length > 100)) return { error: "Bank name must be at most 100 characters" };
  const upiRaw = optional(b.upi_id);
  if (upiRaw !== null && (typeof upiRaw !== "string" || !UPI_RE.test(upiRaw.trim()))) return { error: "UPI id must look like name@bank" };

  return { value: { account_holder_name: holder, account_number: numberRaw, ifsc, bank_name: bankRaw === null ? null : bankRaw.trim(), upi_id: upiRaw === null ? null : upiRaw.trim() } };
}

/** The rider's own view: the number is only ever its last 4 digits. */
function presentMasked(row) {
  if (!row) return null;
  return {
    account_holder_name: row.account_holder_name, account_number_last4: row.account_number_last4, ifsc: row.ifsc,
    bank_name: row.bank_name, upi_id: row.upi_id, updated_at: row.updated_at,
  };
}

/** The admin view for super_admin / ops (who settle): the same plus the full number. If it can't be decrypted it is null and flagged. */
function presentFull(row) {
  if (!row) return null;
  const number = decrypt(row.account_number_enc);
  return { ...presentMasked(row), account_number: number, ...(number === null ? { account_number_unavailable: true } : {}) };
}

async function getRow(conn, riderId) {
  return conn("rider_bank_accounts").where({ rider_id: riderId }).first();
}

const snapshot = (holder, last4, ifsc, upi) => ({ account_holder_name: holder, account_number_last4: last4, ifsc, upi_id: upi });

/**
 * Creates or replaces the rider's account (the whole form each time). An identical resubmit changes nothing and writes no history.
 * A change to an EXISTING account also pushes the rider ("your payout account was updated"): the account-takeover mitigation.
 */
async function saveForRider(riderId, value) {
  const enc = encrypt(value.account_number); // throws 503 if the key isn't configured, before anything is written
  const last4 = value.account_number.slice(-4);
  const outcome = await db.transaction(async (trx) => {
    const existing = await trx("rider_bank_accounts").where({ rider_id: riderId }).forUpdate().first();
    if (!existing) {
      await trx("rider_bank_accounts").insert({
        rider_id: riderId, account_holder_name: value.account_holder_name, account_number_enc: enc, account_number_last4: last4,
        ifsc: value.ifsc, bank_name: value.bank_name, upi_id: value.upi_id,
      });
      await trx("rider_bank_account_history").insert({
        rider_id: riderId, action: "create", after_holder: value.account_holder_name, after_last4: last4, after_ifsc: value.ifsc, after_upi: value.upi_id,
      });
      return { changed: true, created: true };
    }
    const same = existing.account_holder_name === value.account_holder_name && decrypt(existing.account_number_enc) === value.account_number
      && existing.ifsc === value.ifsc && (existing.bank_name || null) === value.bank_name && (existing.upi_id || null) === value.upi_id;
    if (same) return { changed: false, created: false };
    await trx("rider_bank_accounts").where({ rider_id: riderId }).update({
      account_holder_name: value.account_holder_name, account_number_enc: enc, account_number_last4: last4,
      ifsc: value.ifsc, bank_name: value.bank_name, upi_id: value.upi_id, updated_at: trx.fn.now(),
    });
    await trx("rider_bank_account_history").insert({
      rider_id: riderId, action: "update",
      before_holder: existing.account_holder_name, before_last4: existing.account_number_last4, before_ifsc: existing.ifsc, before_upi: existing.upi_id,
      after_holder: value.account_holder_name, after_last4: last4, after_ifsc: value.ifsc, after_upi: value.upi_id,
    });
    return { changed: true, created: false };
  });
  if (outcome.changed && !outcome.created) {
    notifyLater(() => sendToOwner("rider", riderId, {
      title: "Payout account updated", body: "Your bank / UPI details for payouts were changed. If this wasn't you, contact Fengle right away.", data: { type: "bank_account_updated" },
    }));
  }
  return outcome;
}

/** Change log for the admin view: last-4s and non-secret fields only, newest first. */
async function historyFor(conn, riderId, limit = 50) {
  const rows = await conn("rider_bank_account_history").where({ rider_id: riderId }).orderBy("id", "desc").limit(limit);
  return rows.map((r) => ({
    id: r.id, action: r.action, changed_by: r.changed_by,
    before: r.action === "create" ? null : snapshot(r.before_holder, r.before_last4, r.before_ifsc, r.before_upi),
    after: snapshot(r.after_holder, r.after_last4, r.after_ifsc, r.after_upi),
    created_at: r.created_at,
  }));
}

module.exports = { BankError, validateInput, presentMasked, presentFull, getRow, saveForRider, historyFor, encrypt, decrypt, getKey };
