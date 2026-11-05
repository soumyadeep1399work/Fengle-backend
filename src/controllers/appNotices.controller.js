const db = require("../config/db");

const TITLE_MAX = 80;
const BODY_MAX = 500;
const URL_MAX = 500;
const CTA_MAX = 30;
const CTA_TARGETS = ["none", "coupons"];

const asDate = (v) => (v == null || v === "" ? null : new Date(v));

/** A notice is live when it is switched on and now is inside its optional start/end window. Done in JS on the Date values the driver
 *  hands back, so the stored times round-trip however the server's timezone is set. */
function windowState(row, now = new Date()) {
  if (!row.is_active) return "hidden";
  if (row.starts_at && new Date(row.starts_at) > now) return "scheduled";
  if (row.ends_at && new Date(row.ends_at) < now) return "ended";
  return "live";
}

const serialize = (r) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  image_url: r.image_url,
  cta_label: r.cta_label,
  cta_target: r.cta_target,
  starts_at: r.starts_at ? new Date(r.starts_at).toISOString() : null,
  ends_at: r.ends_at ? new Date(r.ends_at).toISOString() : null,
  is_active: Boolean(r.is_active),
  revision: r.revision,
  state: windowState(r),
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** GET /app-notice: public. The newest LIVE notice, or { notice: null }. The Customer app shows it once after login. */
async function getLive(req, res) {
  const rows = await db("app_notices").where({ is_active: true }).orderBy("id", "desc").limit(20);
  const live = rows.find((r) => windowState(r) === "live");
  res.set("Cache-Control", "public, max-age=30");
  if (!live) return res.json({ notice: null });
  res.json({
    notice: {
      id: live.id,
      revision: live.revision,
      title: live.title,
      body: live.body,
      image_url: live.image_url,
      cta_label: live.cta_target !== "none" ? live.cta_label : null,
      cta_target: live.cta_target,
    },
  });
}

/** GET /admin/app-notices: all notices, newest first, each with its state (live / scheduled / ended / hidden). */
async function listAdmin(req, res) {
  const rows = await db("app_notices").orderBy("id", "desc");
  res.json({ notices: rows.map(serialize) });
}

function validate(body, { partial, current }) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const t = String(body.title ?? "").trim();
    if (!t || t.length > TITLE_MAX) return { error: `title is required (max ${TITLE_MAX} characters)` };
    out.title = t;
  }
  if (body.body !== undefined) {
    const b = body.body == null ? "" : String(body.body).trim();
    if (b.length > BODY_MAX) return { error: `message can be at most ${BODY_MAX} characters` };
    out.body = b || null;
  }
  if (body.image_url !== undefined) {
    const u = body.image_url == null ? "" : String(body.image_url).trim();
    if (u && (!/^https?:\/\/\S+$/i.test(u) || u.length > URL_MAX)) return { error: "image_url must be a valid http(s) URL" };
    out.image_url = u || null;
  }
  if (body.cta_target !== undefined) {
    if (!CTA_TARGETS.includes(body.cta_target)) return { error: `cta_target must be one of: ${CTA_TARGETS.join(", ")}` };
    out.cta_target = body.cta_target;
  }
  if (body.cta_label !== undefined) {
    const l = body.cta_label == null ? "" : String(body.cta_label).trim();
    if (l.length > CTA_MAX) return { error: `button text can be at most ${CTA_MAX} characters` };
    out.cta_label = l || null;
  }
  for (const k of ["starts_at", "ends_at"]) {
    if (body[k] !== undefined) {
      const d = asDate(body[k]);
      if (d && Number.isNaN(d.getTime())) return { error: `${k} is not a valid date` };
      out[k] = d;
    }
  }
  if (body.is_active !== undefined) out.is_active = Boolean(body.is_active);

  // Cross-field checks on the values as they will be after this change.
  const after = { ...(current || {}), ...out };
  if (after.cta_target && after.cta_target !== "none" && !after.cta_label) return { error: "Enter the button text, or set the button to open nothing" };
  if (after.starts_at && after.ends_at && new Date(after.ends_at) <= new Date(after.starts_at)) return { error: "ends_at must be after starts_at" };
  return { value: out };
}

// Changing what the customer SEES makes the notice new again; changing only when/whether it is live does not.
const CONTENT_FIELDS = ["title", "body", "image_url", "cta_label", "cta_target"];

/** POST /admin/app-notices */
async function create(req, res) {
  const { error, value } = validate(req.body || {}, { partial: false });
  if (error) return res.status(400).json({ error });
  const [id] = await db("app_notices").insert({ is_active: true, ...value });
  res.status(201).json({ notice: serialize(await db("app_notices").where({ id }).first()) });
}

/** PATCH /admin/app-notices/:id */
async function update(req, res) {
  const id = Number(req.params.id);
  const row = await db("app_notices").where({ id }).first();
  if (!row) return res.status(404).json({ error: "Notice not found" });
  const { error, value } = validate(req.body || {}, { partial: true, current: row });
  if (error) return res.status(400).json({ error });
  if (Object.keys(value).length === 0) return res.status(400).json({ error: "Nothing to change" });
  const contentChanged = CONTENT_FIELDS.some((k) => k in value && (value[k] ?? null) !== (row[k] ?? null));
  await db("app_notices").where({ id }).update({ ...value, ...(contentChanged ? { revision: row.revision + 1 } : {}) });
  res.json({ notice: serialize(await db("app_notices").where({ id }).first()) });
}

/** DELETE /admin/app-notices/:id */
async function remove(req, res) {
  const n = await db("app_notices").where({ id: Number(req.params.id) }).delete();
  if (!n) return res.status(404).json({ error: "Notice not found" });
  res.json({ deleted: true });
}

module.exports = { getLive, listAdmin, create, update, remove, windowState };
