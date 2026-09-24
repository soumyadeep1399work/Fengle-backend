// Dev-only: push an order through accepted -> picked_up -> on_the_way -> delivered
// without the Restaurant/Rider panels.
//
//   node scripts/advance-order.js <orderId>                 # one step (watch the app update)
//   node scripts/advance-order.js <orderId> --to=delivered  # all the way (also: accepted | picked_up | on_the_way)
//   node scripts/advance-order.js <orderId> --all           # same as --to=delivered
require("dotenv").config();

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production.");
  process.exit(1);
}

const { advanceOrder } = require("../src/services/devtools.service");

const args = process.argv.slice(2);
const orderId = args.find((a) => /^\d+$/.test(a));
const toArg = args.find((a) => a.startsWith("--to="));
const to = args.includes("--all") ? "delivered" : toArg ? toArg.slice(5) : undefined;

if (!orderId) {
  console.error("Usage: node scripts/advance-order.js <orderId> [--to=accepted|picked_up|on_the_way|delivered | --all]");
  process.exit(1);
}

advanceOrder(orderId, { to })
  .then((r) => {
    console.log(r.steps.length ? r.steps.join("\n") : "(no change — order is already at or past that step)");
    r.notes.forEach((n) => console.log(`note: ${n}`));
    console.log(`order #${r.orderId} is now: ${r.status}${r.eta_minutes ? ` (eta ${r.eta_minutes} min)` : ""}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
