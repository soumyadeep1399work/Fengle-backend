const bcrypt = require("bcrypt");
const db = require("../config/db");

const ROLES = ["super_admin", "ops", "support"];
const MIN_PASSWORD_LENGTH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Never password_hash — every read of an admin row goes through this list.
const PUBLIC_COLUMNS = ["id", "name", "email", "role", "is_active", "last_login_at", "created_at"];

function present(row) {
  return { ...row, is_active: !!row.is_active };
}

async function loadPublic(id) {
  const row = await db("admins").where({ id }).select(PUBLIC_COLUMNS).first();
  return row ? present(row) : null;
}

function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 72) return "password must be at most 72 characters"; // bcrypt ignores everything past 72 bytes
  return null;
}

/** GET /admin/admins — super_admin only. */
async function listAdmins(req, res) {
  const rows = await db("admins").orderBy("id").select(PUBLIC_COLUMNS);
  res.json({ admins: rows.map(present) });
}

/** POST /admin/admins { name, email, password, role } — super_admin only. */
async function createAdmin(req, res) {
  const { name, email, password, role } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
    return res.status(400).json({ error: "name must be a non-empty string of at most 120 characters" });
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim()) || email.trim().length > 150) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });

  const cleanEmail = email.trim();
  const clash = await db("admins").whereRaw("LOWER(email) = ?", [cleanEmail.toLowerCase()]).first();
  if (clash) return res.status(409).json({ error: "An admin with this email already exists" });

  const password_hash = await bcrypt.hash(password, 10);
  const [id] = await db("admins").insert({ name: name.trim(), email: cleanEmail, password_hash, role });
  res.status(201).json({ admin: await loadPublic(id) });
}

/**
 * PATCH /admin/admins/:id — any of { name, role, is_active, password } (password = reset).
 * Guards: you can't change your own role or disable yourself, and the last
 * active super_admin can't be demoted or disabled. No delete — disabling is enough.
 * A disable (and a role change) takes effect on the very next request, because
 * requireAuth re-reads the admin row every time rather than trusting the 30-day JWT.
 */
async function updateAdmin(req, res) {
  const id = Number(req.params.id);
  const { name, role, is_active, password } = req.body || {};

  const target = await db("admins").where({ id }).first();
  if (!target) return res.status(404).json({ error: "Admin not found" });

  const updates = {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: "name must be a non-empty string of at most 120 characters" });
    }
    updates.name = name.trim();
  }
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    updates.role = role;
  }
  if (is_active !== undefined) {
    if (typeof is_active !== "boolean") return res.status(400).json({ error: "is_active must be true or false" });
    updates.is_active = is_active;
  }
  if (password !== undefined) {
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    updates.password_hash = await bcrypt.hash(password, 10);
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update (name, role, is_active, password)" });
  }

  const isSelf = id === req.auth.id;
  const changesRole = updates.role !== undefined && updates.role !== target.role;
  const disables = updates.is_active === false && !!target.is_active;
  if (isSelf && changesRole) return res.status(400).json({ error: "You can't change your own role" });
  if (isSelf && disables) return res.status(400).json({ error: "You can't disable your own account" });

  const losesSuperAdmin = !!target.is_active && target.role === "super_admin" && (changesRole || disables);
  if (losesSuperAdmin) {
    const [{ n }] = await db("admins").where({ role: "super_admin", is_active: true }).whereNot({ id }).count({ n: "*" });
    if (Number(n) === 0) {
      return res.status(409).json({ error: "This is the last active super admin — promote or enable another one first" });
    }
  }

  await db("admins").where({ id }).update(updates);
  res.json({ admin: await loadPublic(id) });
}

/** POST /admin/me/password { current_password, new_password } — any admin. */
async function changeMyPassword(req, res) {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== "string" || !current_password) {
    return res.status(400).json({ error: "current_password is required" });
  }
  const problem = passwordProblem(new_password);
  if (problem) return res.status(400).json({ error: problem.replace("password", "new_password") });
  if (new_password === current_password) return res.status(400).json({ error: "new_password must be different from the current one" });

  const admin = await db("admins").where({ id: req.auth.id }).select("id", "password_hash").first();
  // 400, not 401: the panel signs the user out on any 401, and a mistyped current password isn't a dead session.
  if (!admin || !(await bcrypt.compare(current_password, admin.password_hash))) {
    return res.status(400).json({ error: "Current password is incorrect" });
  }

  await db("admins").where({ id: admin.id }).update({ password_hash: await bcrypt.hash(new_password, 10) });
  res.json({ message: "Password updated" });
}

module.exports = { listAdmins, createAdmin, updateAdmin, changeMyPassword, ROLES, MIN_PASSWORD_LENGTH };
