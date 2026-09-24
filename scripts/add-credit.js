// Dev-only: give a test customer Platter credits so the wallet payment option
// can be exercised. Goes through the real wallet ledger (reason manual_adjustment).
//
//   node scripts/add-credit.js <10-digit phone> <amount>
//   node scripts/add-credit.js 6558899886 500
require("dotenv").config();

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production.");
  process.exit(1);
}

const { addCredit } = require("../src/services/devtools.service");
const [phone, amount] = process.argv.slice(2);

if (!phone || !amount) {
  console.error("Usage: node scripts/add-credit.js <10-digit phone> <amount>");
  process.exit(1);
}

addCredit(phone, amount)
  .then((r) => {
    console.log(`Added ₹${r.added} to ${r.phone}. New balance: ₹${r.balance}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
