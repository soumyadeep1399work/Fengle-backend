const db = require("../config/db");
const { sendToOwner, notifyLater } = require("./push.service");
const riderBank = require("./riderBank.service");

/**
 * Kitchen payout account — the same secret-handling as the rider one (see riderBank.service.js): the number is AES-256-GCM
 * encrypted with BANK_DATA_KEY (no plaintext fallback, 503 without it), only the last 4 digits are kept in the clear, and the full
 * number only ever leaves via presentFull for super_admin / ops reads. Validation, masking and crypto are shared with the rider
 * module so the two can't drift; only the tables and the push target differ.
 */

const { BankError, validateInput, presentMasked, presentFull, encrypt, decrypt } = riderBank;

async function getRow(conn, restaurantId) {
  return conn("restaurant_bank_accounts").where({ restaurant_id: restaurantId }).first();
}

const snapshot = (holder, last4, ifsc, upi) => ({ account_holder_name: holder, account_number_last4: last4, ifsc, upi_id: upi });

/**
 * Creates or replaces the kitchen's account (the whole form each time). An identical resubmit changes nothing and writes no history.
 * A change to an EXISTING account also pushes the kitchen ("your payout account was updated"): the account-takeover mitigation.
 */
async function saveForRestaurant(restaurantId, value) {
  const enc = encrypt(value.account_number); // throws 503 if the key isn't configured, before anything is written
  const last4 = value.account_number.slice(-4);
  const outcome = await db.transaction(async (trx) => {
    const existing = await trx("restaurant_bank_accounts").where({ restaurant_id: restaurantId }).forUpdate().first();
    if (!existing) {
      await trx("restaurant_bank_accounts").insert({
        restaurant_id: restaurantId, account_holder_name: value.account_holder_name, account_number_enc: enc, account_number_last4: last4,
        ifsc: value.ifsc, bank_name: value.bank_name, upi_id: value.upi_id,
      });
      await trx("restaurant_bank_account_history").insert({
        restaurant_id: restaurantId, action: "create", after_holder: value.account_holder_name, after_last4: last4, after_ifsc: value.ifsc, after_upi: value.upi_id,
      });
      return { changed: true, created: true };
    }
    const same = existing.account_holder_name === value.account_holder_name && decrypt(existing.account_number_enc) === value.account_number
      && existing.ifsc === value.ifsc && (existing.bank_name || null) === value.bank_name && (existing.upi_id || null) === value.upi_id;
    if (same) return { changed: false, created: false };
    await trx("restaurant_bank_accounts").where({ restaurant_id: restaurantId }).update({
      account_holder_name: value.account_holder_name, account_number_enc: enc, account_number_last4: last4,
      ifsc: value.ifsc, bank_name: value.bank_name, upi_id: value.upi_id, updated_at: trx.fn.now(),
    });
    await trx("restaurant_bank_account_history").insert({
      restaurant_id: restaurantId, action: "update",
      before_holder: existing.account_holder_name, before_last4: existing.account_number_last4, before_ifsc: existing.ifsc, before_upi: existing.upi_id,
      after_holder: value.account_holder_name, after_last4: last4, after_ifsc: value.ifsc, after_upi: value.upi_id,
    });
    return { changed: true, created: false };
  });
  if (outcome.changed && !outcome.created) {
    notifyLater(() => sendToOwner("restaurant", restaurantId, {
      title: "Payout account updated", body: "Your bank / UPI details for payouts were changed. If this wasn't you, contact Fengle right away.", data: { type: "bank_account_updated" },
    }));
  }
  return outcome;
}

/** Change log for the admin view: last-4s and non-secret fields only, newest first. */
async function historyFor(conn, restaurantId, limit = 50) {
  const rows = await conn("restaurant_bank_account_history").where({ restaurant_id: restaurantId }).orderBy("id", "desc").limit(limit);
  return rows.map((r) => ({
    id: r.id, action: r.action, changed_by: r.changed_by,
    before: r.action === "create" ? null : snapshot(r.before_holder, r.before_last4, r.before_ifsc, r.before_upi),
    after: snapshot(r.after_holder, r.after_last4, r.after_ifsc, r.after_upi),
    created_at: r.created_at,
  }));
}

module.exports = { BankError, validateInput, presentMasked, presentFull, getRow, saveForRestaurant, historyFor };
