// One-off CLI to bootstrap admin accounts — there is no admin signup
// endpoint (same manual-only posture as restaurant onboarding), so this is
// the only way an admin account gets created.
//
// Usage: node scripts/create-admin.js "Name" "email@example.com" "password" [role]
// role defaults to "ops"; pass "super_admin" for the first account, or "support" for a read-only
// account that can only cancel orders. (Day-to-day accounts are created from the Admin Panel.)
require("dotenv").config();
const bcrypt = require("bcrypt");
const db = require("../src/config/db");

async function main() {
  const [name, email, password, role = "ops"] = process.argv.slice(2);

  if (!name || !email || !password) {
    console.error('Usage: node scripts/create-admin.js "Name" "email@example.com" "password" [role]');
    process.exit(1);
  }
  if (!["super_admin", "ops", "support"].includes(role)) {
    console.error('role must be "super_admin", "ops" or "support"');
    process.exit(1);
  }

  const existing = await db("admins").where({ email }).first();
  if (existing) {
    console.error(`An admin with email ${email} already exists (id ${existing.id})`);
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);
  const [id] = await db("admins").insert({ name, email, password_hash, role });

  console.log(`Created admin #${id} (${email}, role: ${role})`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to create admin:", err);
  process.exit(1);
});
