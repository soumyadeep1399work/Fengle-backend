const db = require("../config/db");

/**
 * The support contact the Restaurant and Rider apps show (Call / WhatsApp / email / hours). An admin can set it in the panel
 * (app_settings row "support_contact"); until one saves it, the server's env values (SUPPORT_PHONE / SUPPORT_WHATSAPP / SUPPORT_EMAIL /
 * SUPPORT_HOURS) are used. Once saved, the saved values are the whole truth: a field an admin cleared stays hidden (null) and does NOT
 * fall back to env, so "remove this number" really removes it.
 */

const KEY = "support_contact";
const FIELDS = ["phone", "whatsapp", "email", "hours"];

const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fromEnv() {
  const pick = (name) => { const v = (process.env[name] || "").trim(); return v || null; };
  return { phone: pick("SUPPORT_PHONE"), whatsapp: pick("SUPPORT_WHATSAPP"), email: pick("SUPPORT_EMAIL"), hours: pick("SUPPORT_HOURS") };
}

/** { phone, whatsapp, email, hours (each string | null), source: "admin" | "env", updated_at, updated_by } */
async function current() {
  const row = await db("app_settings as s").leftJoin("admins as a", "a.id", "s.updated_by_admin_id").where("s.key", KEY).select("s.value", "s.updated_at", "a.name as admin_name").first();
  if (!row) return { ...fromEnv(), source: "env", updated_at: null, updated_by: null };
  let saved = {};
  try { saved = JSON.parse(row.value); } catch { saved = {}; }
  return { ...Object.fromEntries(FIELDS.map((f) => [f, typeof saved[f] === "string" && saved[f].trim() ? saved[f].trim() : null])), source: "admin", updated_at: row.updated_at, updated_by: row.admin_name || null };
}

/** The public shape: just the four values. */
async function publicContact() {
  const { phone, whatsapp, email, hours } = await current();
  return { phone, whatsapp, email, hours };
}

/** Validates the whole form. All four keys must be present (null or "" hides one). Returns { error } or { value }. */
function validate(body) {
  const b = body || {};
  const missing = FIELDS.filter((f) => b[f] === undefined);
  if (missing.length) return { error: `Send all four fields (${FIELDS.join(", ")}); use null or "" to hide one. Missing: ${missing.join(", ")}` };
  const out = {};
  for (const f of FIELDS) {
    const v = b[f];
    if (v !== null && typeof v !== "string") return { error: `${f} must be text (or null to hide it)` };
    const t = v === null ? "" : v.trim();
    if (t === "") { out[f] = null; continue; }
    if ((f === "phone" || f === "whatsapp") && !PHONE_RE.test(t)) return { error: `${f} must look like +91 98765 43210 (digits, spaces, dashes, brackets; 6 to 25 characters)` };
    if (f === "email" && (t.length > 120 || !EMAIL_RE.test(t))) return { error: "email must be a valid email address (at most 120 characters)" };
    if (f === "hours" && (t.length > 100 || /[\r\n]/.test(t))) return { error: "hours must be one line of at most 100 characters" };
    out[f] = t;
  }
  return { value: out };
}

async function save(value, adminId) {
  const payload = JSON.stringify(value);
  const exists = await db("app_settings").where({ key: KEY }).first("key");
  if (exists) await db("app_settings").where({ key: KEY }).update({ value: payload, updated_by_admin_id: adminId, updated_at: db.fn.now() });
  else await db("app_settings").insert({ key: KEY, value: payload, updated_by_admin_id: adminId });
}

module.exports = { current, publicContact, validate, save, fromEnv, FIELDS };
