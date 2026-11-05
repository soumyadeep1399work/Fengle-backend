const db = require("../config/db");

// The app shows at most this many (the Customer app caps its list the same way). More is just more swiping.
const MAX_ACTIVE_SLIDES = 5;
const HEADLINE_MAX = 80;
const BODY_MAX = 200;
const URL_MAX = 500;

const ORDER = [{ column: "sort_order" }, { column: "id" }];

const serialize = (r) => ({
  id: r.id,
  image_url: r.image_url,
  headline: r.headline,
  body: r.body,
  sort_order: r.sort_order,
  is_active: Boolean(r.is_active),
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** GET /onboarding-slides: public (shown before login). Active slides only, in order. An empty list tells the app to use its built-in slides. */
async function listPublic(req, res) {
  const rows = await db("onboarding_slides").where({ is_active: true }).orderBy(ORDER).limit(MAX_ACTIVE_SLIDES);
  res.set("Cache-Control", "public, max-age=60");
  res.json({ slides: rows.map((r) => ({ id: r.id, image_url: r.image_url, headline: r.headline, body: r.body })) });
}

/** GET /admin/onboarding-slides: every slide, active or not. */
async function listAdmin(req, res) {
  const rows = await db("onboarding_slides").orderBy(ORDER);
  res.json({ slides: rows.map(serialize), max_active: MAX_ACTIVE_SLIDES });
}

function validate(body, { partial }) {
  const out = {};
  if (!partial || body.image_url !== undefined) {
    const url = String(body.image_url ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > URL_MAX) return { error: "image_url must be a valid http(s) URL (upload a picture first)" };
    out.image_url = url;
  }
  if (!partial || body.headline !== undefined) {
    const h = String(body.headline ?? "").trim();
    if (!h || h.length > HEADLINE_MAX) return { error: `headline is required (max ${HEADLINE_MAX} characters)` };
    out.headline = h;
  }
  if (body.body !== undefined) {
    const b = body.body == null ? "" : String(body.body).trim();
    if (b.length > BODY_MAX) return { error: `body can be at most ${BODY_MAX} characters` };
    out.body = b || null;
  }
  if (body.is_active !== undefined) out.is_active = Boolean(body.is_active);
  return { value: out };
}

async function activeCountExcluding(id) {
  const q = db("onboarding_slides").where({ is_active: true });
  if (id) q.whereNot({ id });
  const row = await q.count({ n: "id" }).first();
  return Number(row.n);
}

/** POST /admin/onboarding-slides: { image_url, headline, body?, is_active? }. Goes to the end of the list. */
async function create(req, res) {
  const { error, value } = validate(req.body || {}, { partial: false });
  if (error) return res.status(400).json({ error });
  const active = value.is_active !== false;
  if (active && (await activeCountExcluding(null)) >= MAX_ACTIVE_SLIDES) {
    return res.status(409).json({ error: `At most ${MAX_ACTIVE_SLIDES} slides can be active. Hide or delete one first.` });
  }
  const top = await db("onboarding_slides").max({ m: "sort_order" }).first();
  const [id] = await db("onboarding_slides").insert({ ...value, is_active: active, sort_order: Number(top.m ?? 0) + 1 });
  res.status(201).json({ slide: serialize(await db("onboarding_slides").where({ id }).first()) });
}

/** PATCH /admin/onboarding-slides/:id: any of image_url, headline, body, is_active. */
async function update(req, res) {
  const id = Number(req.params.id);
  const row = await db("onboarding_slides").where({ id }).first();
  if (!row) return res.status(404).json({ error: "Slide not found" });
  const { error, value } = validate(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  if (Object.keys(value).length === 0) return res.status(400).json({ error: "Nothing to change" });
  if (value.is_active === true && !row.is_active && (await activeCountExcluding(id)) >= MAX_ACTIVE_SLIDES) {
    return res.status(409).json({ error: `At most ${MAX_ACTIVE_SLIDES} slides can be active. Hide or delete one first.` });
  }
  await db("onboarding_slides").where({ id }).update(value);
  res.json({ slide: serialize(await db("onboarding_slides").where({ id }).first()) });
}

/** DELETE /admin/onboarding-slides/:id */
async function remove(req, res) {
  const n = await db("onboarding_slides").where({ id: Number(req.params.id) }).delete();
  if (!n) return res.status(404).json({ error: "Slide not found" });
  res.json({ deleted: true });
}

/** POST /admin/onboarding-slides/reorder: { ids: [3,1,2] } is the new order and must name every slide exactly once. */
async function reorder(req, res) {
  const ids = (req.body?.ids ?? []).map(Number);
  const all = (await db("onboarding_slides").select("id")).map((r) => r.id);
  if (ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every((i) => all.includes(i))) {
    return res.status(400).json({ error: "ids must list every slide exactly once" });
  }
  await db.transaction(async (trx) => {
    for (let i = 0; i < ids.length; i++) await trx("onboarding_slides").where({ id: ids[i] }).update({ sort_order: i + 1 });
  });
  res.json({ slides: (await db("onboarding_slides").orderBy(ORDER)).map(serialize) });
}

module.exports = { listPublic, listAdmin, create, update, remove, reorder, MAX_ACTIVE_SLIDES };
