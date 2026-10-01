// Adds "order_payment" to wallet_ledger.reason — the debit reason for a
// customer paying an order fully from Fengle credits (payment_method:
// "wallet"). That enum value was accepted by the orders table from the start
// but nothing ever actually debited the wallet for it — see order.controller.js.
exports.up = function (knex) {
  return knex.raw(
    `ALTER TABLE wallet_ledger MODIFY COLUMN reason ENUM(
      'cod_collected',
      'settlement_payout',
      'settlement_deduction',
      'order_refund',
      'manual_adjustment',
      'order_payment'
    ) NOT NULL`
  );
};

exports.down = function (knex) {
  return knex.raw(
    `ALTER TABLE wallet_ledger MODIFY COLUMN reason ENUM(
      'cod_collected',
      'settlement_payout',
      'settlement_deduction',
      'order_refund',
      'manual_adjustment'
    ) NOT NULL`
  );
};
