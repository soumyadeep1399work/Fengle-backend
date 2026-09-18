const db = require("../config/db");

const OWNER_TABLE = { customer: "users", rider: "riders" };

/**
 * Every wallet mutation goes through here — never write to wallet_ledger or
 * update a balance column directly from a controller. This keeps the ledger
 * (the source of truth) and the denormalized balance column in sync inside
 * one DB transaction, and gives us one place to reason about money.
 *
 * @param {object} params
 * @param {'customer'|'rider'} params.ownerType
 * @param {number} params.ownerId
 * @param {'credit'|'debit'} params.entryType
 * @param {number} params.amount - always positive; direction comes from entryType
 * @param {'cod_collected'|'settlement_payout'|'settlement_deduction'|'order_refund'|'manual_adjustment'} params.reason
 * @param {number} [params.relatedOrderId]
 * @param {string} [params.notes]
 * @param {import('knex').Knex.Transaction} [trx] - pass an existing transaction to
 *        participate in a larger atomic operation (e.g. order placement + refund)
 */
async function recordEntry(params, trx) {
  const { ownerType, ownerId, entryType, amount, reason, relatedOrderId, notes } = params;

  if (amount <= 0) {
    throw new Error("Wallet entry amount must be positive");
  }
  if (!OWNER_TABLE[ownerType]) {
    throw new Error(`Unknown wallet owner type: ${ownerType}`);
  }

  const run = async (t) => {
    const table = OWNER_TABLE[ownerType];

    // Lock the owner row for update so concurrent settlements/refunds for the
    // same wallet can't race and produce an inconsistent balance_after.
    const owner = await t(table).where({ id: ownerId }).forUpdate().first();
    if (!owner) {
      throw new Error(`${ownerType} ${ownerId} not found`);
    }

    const currentBalance = Number(owner.wallet_balance);
    const delta = entryType === "credit" ? amount : -amount;
    const newBalance = Number((currentBalance + delta).toFixed(2));

    await t("wallet_ledger").insert({
      owner_type: ownerType,
      owner_id: ownerId,
      entry_type: entryType,
      amount,
      balance_after: newBalance,
      reason,
      related_order_id: relatedOrderId || null,
      notes: notes || null,
    });

    await t(table).where({ id: ownerId }).update({ wallet_balance: newBalance });

    return newBalance;
  };

  return trx ? run(trx) : db.transaction(run);
}

async function getBalance(ownerType, ownerId) {
  const table = OWNER_TABLE[ownerType];
  const row = await db(table).where({ id: ownerId }).select("wallet_balance").first();
  return row ? Number(row.wallet_balance) : null;
}

async function getHistory(ownerType, ownerId, { limit = 50, offset = 0 } = {}) {
  return db("wallet_ledger")
    .where({ owner_type: ownerType, owner_id: ownerId })
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset);
}

/**
 * Rider collects COD cash on delivery — logs it as a liability (debit) against
 * the rider's wallet. This is the trigger point referenced in CLAUDE.md: the
 * rider must explicitly confirm the amount at "Mark Delivered" for a COD order.
 */
async function recordCodCollection(riderId, orderId, amount, trx) {
  return recordEntry(
    {
      ownerType: "rider",
      ownerId: riderId,
      entryType: "debit",
      amount,
      reason: "cod_collected",
      relatedOrderId: orderId,
      notes: `COD collected on order #${orderId}`,
    },
    trx
  );
}

/**
 * Customer-side refund/credit — used for the clubbed-order partial-unavailability
 * case (Section 4) and general cancellation refunds.
 */
async function recordCustomerRefund(customerId, orderId, amount, notes, trx) {
  return recordEntry(
    {
      ownerType: "customer",
      ownerId: customerId,
      entryType: "credit",
      amount,
      reason: "order_refund",
      relatedOrderId: orderId,
      notes,
    },
    trx
  );
}

module.exports = {
  recordEntry,
  getBalance,
  getHistory,
  recordCodCollection,
  recordCustomerRefund,
};
