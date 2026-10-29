const db = require("../config/db");
const shipping = require("../services/shippingRules.service");
const { paginationParams } = require("../utils/pagination");

const { KINDS, TYPES, presentRule, presentZone, parseJson } = shipping;
const MAX_AMOUNT = 100000;
const MAX_PERCENT = 1000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const toNum = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseMatch(match) {
  if (!isPlainObject(match)) return { error: "match must be an object { pincodes: [], circles: [{ lat, lng, radius_km }] }" };
  const extra = Object.keys(match).filter((k) => !["pincodes", "circles"].includes(k));
  if (extra.length) return { error: `match has unknown key(s): ${extra.join(", ")}` };
  const pincodes = match.pincodes === undefined ? [] : match.pincodes;
  const circles = match.circles === undefined ? [] : match.circles;
  if (!Array.isArray(pincodes) || !pincodes.every((p) => /^\d{6}$/.test(String(p)))) return { error: "match.pincodes must be a list of 6-digit pincodes" };
  if (!Array.isArray(circles)) return { error: "match.circles must be a list of { lat, lng, radius_km }" };
  const cleanCircles = [];
  for (const c of circles) {
    const lat = toNum(c && c.lat), lng = toNum(c && c.lng), radius = toNum(c && c.radius_km);
    if (!isNum(lat) || lat < -90 || lat > 90) return { error: "each circle needs a lat between -90 and 90" };
    if (!isNum(lng) || lng < -180 || lng > 180) return { error: "each circle needs a lng between -180 and 180" };
    if (!isNum(radius) || radius <= 0 || radius > 100) return { error: "each circle needs a radius_km above 0 (up to 100)" };
    cleanCircles.push({ lat, lng, radius_km: radius });
  }
  if (!pincodes.length && !cleanCircles.length) return { error: "a zone needs at least one circle or pincode" };
  return { value: { pincodes: [...new Set(pincodes.map(String))], circles: cleanCircles } };
}

function parseRange(range, label) {
  if (!isPlainObject(range)) return { error: `conditions.${label} must be an object { min?, max? }` };
  const extra = Object.keys(range).filter((k) => !["min", "max"].includes(k));
  if (extra.length) return { error: `conditions.${label} has unknown key(s): ${extra.join(", ")}` };
  const out = {};
  for (const k of ["min", "max"]) {
    if (range[k] === undefined || range[k] === null) continue;
    const n = toNum(range[k]);
    if (!isNum(n) || n < 0 || n > 10000000) return { error: `conditions.${label}.${k} must be a number of 0 or more` };
    out[k] = n;
  }
  if (out.min != null && out.max != null && out.min >= out.max) return { error: `conditions.${label}: min must be below max (min is inclusive, max exclusive)` };
  return { value: out };
}

function parseConditions(conditions) {
  if (conditions === undefined || conditions === null) return { value: {} };
  if (!isPlainObject(conditions)) return { error: "conditions must be an object" };
  const extra = Object.keys(conditions).filter((k) => !["distance_km", "order_value", "time"].includes(k));
  if (extra.length) return { error: `conditions has unknown key(s): ${extra.join(", ")}` };
  const out = {};
  for (const key of ["distance_km", "order_value"]) {
    if (conditions[key] === undefined) continue;
    const r = parseRange(conditions[key], key);
    if (r.error) return r;
    out[key] = r.value;
  }
  if (conditions.time !== undefined) {
    const t = conditions.time;
    if (!isPlainObject(t)) return { error: "conditions.time must be an object { days?, from?, to? }" };
    const extraT = Object.keys(t).filter((k) => !["days", "from", "to"].includes(k));
    if (extraT.length) return { error: `conditions.time has unknown key(s): ${extraT.join(", ")}` };
    const time = {};
    if (t.days !== undefined) {
      if (!Array.isArray(t.days) || !t.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: "conditions.time.days must be a list of 0-6 (0 = Sunday)" };
      time.days = [...new Set(t.days)].sort();
    }
    const hasFrom = t.from !== undefined && t.from !== null;
    const hasTo = t.to !== undefined && t.to !== null;
    if (hasFrom !== hasTo) return { error: "conditions.time needs both from and to (HH:MM), or neither" };
    if (hasFrom) {
      if (!HHMM.test(String(t.from)) || !HHMM.test(String(t.to))) return { error: "conditions.time.from / to must be HH:MM (24h)" };
      if (t.from === t.to) return { error: "conditions.time.from and to can't be the same (use days alone for a whole day)" };
      time.from = t.from; time.to = t.to;
    }
    if (!Object.keys(time).length) return { error: "conditions.time needs days and/or from + to" };
    out.time = time;
  }
  return { value: out };
}

const amountOk = (v, max = MAX_AMOUNT) => isNum(v) && v >= 0 && v <= max;

function parseCharge(type, charge, kind) {
  if (!isPlainObject(charge)) return { error: "charge must be an object" };
  const keys = Object.keys(charge);
  const allowed = { base: ["flat", "bands", "after_kitchen_radius"], add: ["flat", "percent"], free: [], min: ["amount"], max: ["amount"] }[type];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return { error: `charge for a ${type} rule has unknown key(s): ${extra.join(", ")}` };

  if (type === "free") return { value: {} };
  if (type === "min" || type === "max") {
    const amount = toNum(charge.amount);
    if (!amountOk(amount)) return { error: `charge.amount must be a number from 0 to ${MAX_AMOUNT}` };
    return { value: { amount } };
  }
  if (type === "add") {
    const out = {};
    if (charge.flat !== undefined) { const f = toNum(charge.flat); if (!amountOk(f)) return { error: `charge.flat must be a number from 0 to ${MAX_AMOUNT}` }; out.flat = f; }
    if (charge.percent !== undefined) { const p = toNum(charge.percent); if (!amountOk(p, MAX_PERCENT)) return { error: `charge.percent must be a number from 0 to ${MAX_PERCENT}` }; out.percent = p; }
    if (out.flat === undefined && out.percent === undefined) return { error: "an add rule needs charge.flat and/or charge.percent" };
    return { value: out };
  }

  // base
  const out = {};
  if (charge.flat !== undefined) { const f = toNum(charge.flat); if (!amountOk(f)) return { error: `charge.flat must be a number from 0 to ${MAX_AMOUNT}` }; out.flat = f; }
  if (charge.bands !== undefined) {
    const bands = charge.bands;
    if (!Array.isArray(bands) || bands.length === 0) return { error: "charge.bands must be a non-empty list of { from_km, to_km, per_km }" };
    const clean = [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i] || {};
      const from = toNum(b.from_km), perKm = toNum(b.per_km);
      const to = b.to_km === null || b.to_km === undefined ? null : toNum(b.to_km);
      if (!isNum(from) || from < 0) return { error: `band ${i + 1}: from_km must be a number of 0 or more` };
      if (!amountOk(perKm)) return { error: `band ${i + 1}: per_km must be a number from 0 to ${MAX_AMOUNT}` };
      if (to !== null && (!isNum(to) || to <= from)) return { error: `band ${i + 1}: to_km must be above from_km (or null for no upper limit)` };
      if (to === null && i !== bands.length - 1) return { error: "only the last band may have to_km null" };
      if (i === 0 && from !== 0) return { error: "bands must start at 0 km" };
      if (i > 0 && from !== clean[i - 1].to_km) return { error: `band ${i + 1} must start where band ${i} ends (bands are contiguous and can't overlap)` };
      clean.push({ from_km: from, to_km: to, per_km: perKm });
    }
    out.bands = clean;
  }
  if (out.flat === undefined && out.bands === undefined) return { error: "a base rule needs charge.flat and/or charge.bands" };
  if (charge.after_kitchen_radius !== undefined) {
    if (typeof charge.after_kitchen_radius !== "boolean") return { error: "charge.after_kitchen_radius must be true or false" };
    if (charge.after_kitchen_radius && kind !== "customer_fee") return { error: "after_kitchen_radius only applies to customer delivery fees" };
    if (charge.after_kitchen_radius) out.after_kitchen_radius = true;
  }
  return { value: out };
}

function parseDate(v, label) {
  if (v === undefined) return { skip: true };
  if (v === null || v === "") return { value: null };
  const d = new Date(v);
  if (typeof v === "boolean" || Number.isNaN(d.getTime())) return { error: `${label} must be a valid date-time` };
  return { value: d };
}

// ---------------------------------------------------------------------------
// History + invariants
// ---------------------------------------------------------------------------

async function logHistory(trx, { entity, entityId, kind, action, before, after, adminId }) {
  await trx("shipping_history").insert({
    entity, entity_id: entityId, kind: kind || null, action,
    before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null, admin_id: adminId,
  });
}

/**
 * The rule that guarantees a delivery can always be priced: an ACTIVE base rule for the kind that applies everywhere, with no
 * conditions and no date window. Returns the ids of every rule that qualifies (so the last one can be protected).
 */
async function everywhereBaseIds(conn, kind) {
  const rows = await conn("shipping_rules").where({ kind, type: "base", zone_id: null, is_deleted: false, is_active: true }).whereNull("valid_from").whereNull("valid_to");
  return rows.filter((r) => Object.keys(parseJson(r.conditions, {})).length === 0).map((r) => r.id);
}

async function assertEverywhereBase(trx, kind) {
  if ((await everywhereBaseIds(trx, kind)).length === 0) {
    throw new HttpError(409, `Every ${kind === "customer_fee" ? "delivery fee" : "rider pay"} set needs an active "everywhere" base rule with no conditions and no dates — otherwise some deliveries couldn't be priced`, "last_everywhere_base");
  }
}

async function decorateRules(conn, rows) {
  const zoneIds = [...new Set(rows.map((r) => r.zone_id).filter((z) => z != null))];
  const zones = zoneIds.length ? await conn("shipping_zones").whereIn("id", zoneIds).select("id", "name") : [];
  const zoneName = Object.fromEntries(zones.map((z) => [z.id, z.name]));
  const protectedIds = {};
  for (const kind of KINDS) {
    const ids = await everywhereBaseIds(conn, kind);
    if (ids.length === 1) protectedIds[kind] = ids[0];
  }
  const now = new Date();
  return rows.map((r) => ({
    ...presentRule(r),
    zone_name: r.zone_id == null ? null : zoneName[r.zone_id] || null,
    is_in_effect_now: Boolean(r.is_active) && shipping.inEffect(r, now),
    is_last_everywhere_base: protectedIds[r.kind] === r.id,
  }));
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** GET /admin/shipping/zones → { zones } sorted by priority (inactive included, deleted not). */
async function listZones(req, res) {
  const rows = await db("shipping_zones").where({ is_deleted: false }).orderBy("priority").orderBy("id");
  res.json({ zones: rows.map(presentZone) });
}

/** POST /admin/shipping/zones { name, is_active?, match } → 201 { zone } (super_admin) */
async function createZone(req, res) {
  const { name, is_active, match } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) return res.status(400).json({ error: "name must be 1 to 100 characters" });
  if (is_active !== undefined && typeof is_active !== "boolean") return res.status(400).json({ error: "is_active must be true or false" });
  const m = parseMatch(match);
  if (m.error) return res.status(400).json({ error: m.error });
  const zone = await db.transaction(async (trx) => {
    const [{ max }] = await trx("shipping_zones").where({ is_deleted: false }).max({ max: "priority" });
    const [id] = await trx("shipping_zones").insert({ name: name.trim(), is_active: is_active !== false, priority: Number(max || 0) + 1, match: JSON.stringify(m.value), created_by_admin_id: req.auth.id });
    const row = presentZone(await trx("shipping_zones").where({ id }).first());
    await logHistory(trx, { entity: "zone", entityId: id, action: "create", after: row, adminId: req.auth.id });
    return row;
  });
  res.status(201).json({ zone });
}

/** PATCH /admin/shipping/zones/:id any of { name, is_active, match } → { zone } (super_admin) */
async function updateZone(req, res) {
  const id = Number(req.params.id);
  const body = req.body || {};
  const existing = await db("shipping_zones").where({ id, is_deleted: false }).first();
  if (!existing) return res.status(404).json({ error: "Zone not found" });
  const updates = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return res.status(400).json({ error: "name must be 1 to 100 characters" });
    updates.name = body.name.trim();
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") return res.status(400).json({ error: "is_active must be true or false" });
    updates.is_active = body.is_active;
  }
  if (body.match !== undefined) {
    const m = parseMatch(body.match);
    if (m.error) return res.status(400).json({ error: m.error });
    updates.match = JSON.stringify(m.value);
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "Send at least one of: name, is_active, match" });
  const zone = await db.transaction(async (trx) => {
    await trx("shipping_zones").where({ id }).update({ ...updates, updated_at: trx.fn.now() });
    const after = presentZone(await trx("shipping_zones").where({ id }).first());
    await logHistory(trx, { entity: "zone", entityId: id, action: "update", before: presentZone(existing), after, adminId: req.auth.id });
    return after;
  });
  res.json({ zone });
}

/** DELETE /admin/shipping/zones/:id (soft) — its rules are removed with it (both audited). → { message } (super_admin) */
async function deleteZone(req, res) {
  const id = Number(req.params.id);
  const existing = await db("shipping_zones").where({ id, is_deleted: false }).first();
  if (!existing) return res.status(404).json({ error: "Zone not found" });
  await db.transaction(async (trx) => {
    const rules = await trx("shipping_rules").where({ zone_id: id, is_deleted: false });
    for (const r of rules) {
      await trx("shipping_rules").where({ id: r.id }).update({ is_deleted: true, updated_at: trx.fn.now() });
      await logHistory(trx, { entity: "rule", entityId: r.id, kind: r.kind, action: "delete", before: presentRule(r), adminId: req.auth.id });
    }
    await trx("shipping_zones").where({ id }).update({ is_deleted: true, updated_at: trx.fn.now() });
    await logHistory(trx, { entity: "zone", entityId: id, action: "delete", before: presentZone(existing), adminId: req.auth.id });
  });
  res.json({ message: "Zone deleted" });
}

/** Shared by the zone and rule reorder endpoints: assigns priorities 1..n in the order given. */
async function applyOrder(trx, table, entity, kind, scopeRows, ids, adminId) {
  const given = ids.map(Number);
  const scopeIds = scopeRows.map((r) => r.id);
  if (new Set(given).size !== given.length || given.some((i) => !scopeIds.includes(i))) throw new HttpError(400, "ids must be unique and belong to this list");
  const missing = scopeRows.filter((r) => r.is_active && !given.includes(r.id));
  if (missing.length) throw new HttpError(400, `ids must include every active item in the list (missing: ${missing.map((r) => r.id).join(", ")})`);
  const rest = scopeRows.filter((r) => !given.includes(r.id)).map((r) => r.id); // inactive ones left out keep their relative order, after
  const finalOrder = [...given, ...rest];
  for (let i = 0; i < finalOrder.length; i++) {
    const row = scopeRows.find((r) => r.id === finalOrder[i]);
    if (row.priority !== i + 1) {
      await trx(table).where({ id: row.id }).update({ priority: i + 1, updated_at: trx.fn.now() });
      await logHistory(trx, { entity, entityId: row.id, kind, action: "reorder", before: { priority: row.priority }, after: { priority: i + 1 }, adminId });
    }
  }
}

/** POST /admin/shipping/zones/reorder { ids } — every active zone, in the new order → { zones } (super_admin) */
async function reorderZones(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids must be a non-empty list of zone ids" });
  try {
    await db.transaction(async (trx) => {
      const rows = await trx("shipping_zones").where({ is_deleted: false }).orderBy("priority").orderBy("id");
      await applyOrder(trx, "shipping_zones", "zone", null, rows, ids, req.auth.id);
    });
  } catch (e) { if (e instanceof HttpError) return fail(res, e); throw e; }
  const rows = await db("shipping_zones").where({ is_deleted: false }).orderBy("priority").orderBy("id");
  res.json({ zones: rows.map(presentZone) });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Validates a full rule (the merged result for a PATCH). Returns { error } or { fields } ready for the DB.
 * `kind` is fixed once created.
 */
async function validateRule(conn, merged) {
  if (!KINDS.includes(merged.kind)) return { error: `kind must be one of: ${KINDS.join(", ")}` };
  if (!TYPES.includes(merged.type)) return { error: `type must be one of: ${TYPES.join(", ")}` };
  if (typeof merged.name !== "string" || !merged.name.trim() || merged.name.trim().length > 100) return { error: "name must be 1 to 100 characters" };
  if (typeof merged.is_active !== "boolean") return { error: "is_active must be true or false" };
  if (merged.type === "free" && merged.kind !== "customer_fee") return { error: "a free rule only applies to customer delivery fees (a rider payout is never zeroed by a rule)" };
  if (merged.zone_id != null) {
    const zone = await conn("shipping_zones").where({ id: Number(merged.zone_id), is_deleted: false }).first("id");
    if (!zone) return { error: "zone_id does not match an existing zone" };
  }
  const cond = parseConditions(merged.conditions);
  if (cond.error) return cond;
  const charge = parseCharge(merged.type, merged.charge, merged.kind);
  if (charge.error) return charge;
  const from = merged.valid_from ? new Date(merged.valid_from) : null;
  const to = merged.valid_to ? new Date(merged.valid_to) : null;
  if (from && to && from >= to) return { error: "valid_from must be before valid_to" };
  return { fields: { kind: merged.kind, zone_id: merged.zone_id == null ? null : Number(merged.zone_id), name: merged.name.trim(), is_active: merged.is_active, type: merged.type, conditions: JSON.stringify(cond.value), charge: JSON.stringify(charge.value), valid_from: from, valid_to: to } };
}

const withDates = (body, current) => {
  const out = {};
  for (const key of ["valid_from", "valid_to"]) {
    const r = parseDate(body[key], key);
    if (r.error) return { error: r.error };
    out[key] = r.skip ? (current ? current[key] : null) : r.value;
  }
  return { value: out };
};

/** GET /admin/shipping/rules?kind=&zone_id= (zone_id=null for the everywhere rules) → { rules } inactive and dated ones included, deleted not. */
async function listRules(req, res) {
  const { kind, zone_id: zoneId } = req.query;
  if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  let q = db("shipping_rules").where({ is_deleted: false }).orderBy("kind").orderBy("priority").orderBy("id");
  if (kind) q = q.where({ kind });
  if (zoneId !== undefined) {
    if (zoneId === "null" || zoneId === "") q = q.whereNull("zone_id");
    else if (Number.isInteger(Number(zoneId))) q = q.where({ zone_id: Number(zoneId) });
    else return res.status(400).json({ error: "zone_id must be a zone id or the word null" });
  }
  res.json({ rules: await decorateRules(db, await q) });
}

/** POST /admin/shipping/rules { kind, zone_id?, name, is_active?, type, conditions?, charge, valid_from?, valid_to? } → 201 { rule } (super_admin) */
async function createRule(req, res) {
  const body = req.body || {};
  const dates = withDates(body, null);
  if (dates.error) return res.status(400).json({ error: dates.error });
  const merged = { kind: body.kind, zone_id: body.zone_id === undefined ? null : body.zone_id, name: body.name, is_active: body.is_active === undefined ? true : body.is_active, type: body.type, conditions: body.conditions, charge: body.charge, ...dates.value };
  const v = await validateRule(db, merged);
  if (v.error) return res.status(400).json({ error: v.error });
  const rule = await db.transaction(async (trx) => {
    let scope = trx("shipping_rules").where({ kind: v.fields.kind, is_deleted: false });
    scope = v.fields.zone_id == null ? scope.whereNull("zone_id") : scope.where({ zone_id: v.fields.zone_id });
    const [{ max }] = await scope.max({ max: "priority" });
    const [id] = await trx("shipping_rules").insert({ ...v.fields, priority: Number(max || 0) + 1, created_by_admin_id: req.auth.id });
    const row = await trx("shipping_rules").where({ id }).first();
    await logHistory(trx, { entity: "rule", entityId: id, kind: v.fields.kind, action: "create", after: presentRule(row), adminId: req.auth.id });
    return row;
  });
  res.status(201).json({ rule: (await decorateRules(db, [rule]))[0] });
}

/** PATCH /admin/shipping/rules/:id any of { name, zone_id, is_active, type, conditions, charge, valid_from, valid_to } → { rule } (super_admin) */
async function updateRule(req, res) {
  const id = Number(req.params.id);
  const body = req.body || {};
  const existing = await db("shipping_rules").where({ id, is_deleted: false }).first();
  if (!existing) return res.status(404).json({ error: "Rule not found" });
  if (body.kind !== undefined && body.kind !== existing.kind) return res.status(400).json({ error: "kind can't be changed" });
  const editable = ["name", "zone_id", "is_active", "type", "conditions", "charge", "valid_from", "valid_to"];
  if (!editable.some((k) => body[k] !== undefined)) return res.status(400).json({ error: `Send at least one of: ${editable.join(", ")}` });
  const dates = withDates(body, existing);
  if (dates.error) return res.status(400).json({ error: dates.error });
  const merged = {
    kind: existing.kind,
    zone_id: body.zone_id !== undefined ? body.zone_id : existing.zone_id,
    name: body.name !== undefined ? body.name : existing.name,
    is_active: body.is_active !== undefined ? body.is_active : Boolean(existing.is_active),
    type: body.type !== undefined ? body.type : existing.type,
    conditions: body.conditions !== undefined ? body.conditions : parseJson(existing.conditions, {}),
    charge: body.charge !== undefined ? body.charge : parseJson(existing.charge, {}),
    ...dates.value,
  };
  const v = await validateRule(db, merged);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const rule = await db.transaction(async (trx) => {
      await trx("shipping_rules").where({ id }).update({ ...v.fields, updated_at: trx.fn.now() });
      await assertEverywhereBase(trx, existing.kind);
      const row = await trx("shipping_rules").where({ id }).first();
      await logHistory(trx, { entity: "rule", entityId: id, kind: existing.kind, action: "update", before: presentRule(existing), after: presentRule(row), adminId: req.auth.id });
      return row;
    });
    res.json({ rule: (await decorateRules(db, [rule]))[0] });
  } catch (e) { if (e instanceof HttpError) return fail(res, e); throw e; }
}

/** DELETE /admin/shipping/rules/:id (soft) → { message } (super_admin). 409 for the last everywhere base rule of its kind. */
async function deleteRule(req, res) {
  const id = Number(req.params.id);
  const existing = await db("shipping_rules").where({ id, is_deleted: false }).first();
  if (!existing) return res.status(404).json({ error: "Rule not found" });
  try {
    await db.transaction(async (trx) => {
      await trx("shipping_rules").where({ id }).update({ is_deleted: true, updated_at: trx.fn.now() });
      await assertEverywhereBase(trx, existing.kind);
      await logHistory(trx, { entity: "rule", entityId: id, kind: existing.kind, action: "delete", before: presentRule(existing), adminId: req.auth.id });
    });
  } catch (e) { if (e instanceof HttpError) return fail(res, e); throw e; }
  res.json({ message: "Rule deleted" });
}

/** POST /admin/shipping/rules/reorder { kind, zone_id (null for everywhere), ids } — every active rule of that kind + zone, new order → { rules } (super_admin) */
async function reorderRules(req, res) {
  const { kind, zone_id: zoneId, ids } = req.body || {};
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids must be a non-empty list of rule ids" });
  const zone = zoneId === undefined ? null : zoneId;
  const scope = (conn) => { const q = conn("shipping_rules").where({ kind, is_deleted: false }).orderBy("priority").orderBy("id"); return zone === null ? q.whereNull("zone_id") : q.where({ zone_id: Number(zone) }); };
  try {
    await db.transaction(async (trx) => applyOrder(trx, "shipping_rules", "rule", kind, await scope(trx), ids, req.auth.id));
  } catch (e) { if (e instanceof HttpError) return fail(res, e); throw e; }
  res.json({ rules: await decorateRules(db, await scope(db)) });
}

// ---------------------------------------------------------------------------
// History + preview
// ---------------------------------------------------------------------------

/** GET /admin/shipping/history?entity=&kind=&rule_id=&page=&limit= → { history, page, limit, total } newest first */
async function history(req, res) {
  const { entity, kind, rule_id: ruleId } = req.query;
  if (entity && !["rule", "zone"].includes(entity)) return res.status(400).json({ error: "entity must be rule or zone" });
  if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  const { page, limit, offset } = paginationParams(req);
  let base = db("shipping_history as h");
  if (entity) base = base.where("h.entity", entity);
  if (kind) base = base.where("h.kind", kind);
  if (ruleId) base = base.where({ "h.entity": "rule", "h.entity_id": Number(ruleId) });
  const [{ n }] = await base.clone().count({ n: "*" });
  const rows = await base.clone().leftJoin("admins as a", "a.id", "h.admin_id").orderBy("h.id", "desc").limit(limit).offset(offset).select("h.*", "a.name as admin_name");
  res.json({
    history: rows.map((r) => ({ id: r.id, entity: r.entity, entity_id: r.entity_id, kind: r.kind, action: r.action, before: parseJson(r.before, null), after: parseJson(r.after, null), admin_id: r.admin_id, admin_name: r.admin_name || null, created_at: r.created_at })),
    page, limit, total: Number(n),
  });
}

/**
 * POST /admin/shipping/preview { kind, distance_km, order_value?, at?, zone_id? | dropoff: { lat, lng, pincode? }, restaurant_id? }
 * → { amount, zone, applied, breakdown, warnings, fallback } — the exact engine result for a hypothetical delivery, for a "test a delivery" box.
 * Any admin role (it changes nothing).
 */
async function preview(req, res) {
  const b = req.body || {};
  if (!KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` });
  const distance = toNum(b.distance_km);
  if (!isNum(distance) || distance < 0 || distance > 1000) return res.status(400).json({ error: "distance_km must be a number from 0 to 1000" });
  let orderValue;
  if (b.order_value !== undefined && b.order_value !== null && b.order_value !== "") {
    orderValue = toNum(b.order_value);
    if (!isNum(orderValue) || orderValue < 0) return res.status(400).json({ error: "order_value must be a number of 0 or more" });
  }
  let at = new Date();
  if (b.at !== undefined && b.at !== null && b.at !== "") {
    at = new Date(b.at);
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: "at must be a valid date-time" });
  }
  let restaurant = null;
  if (b.restaurant_id !== undefined && b.restaurant_id !== null && b.restaurant_id !== "") {
    restaurant = await db("restaurants").where({ id: Number(b.restaurant_id) }).first("id", "name", "radius_km", "lat", "lng");
    if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });
  }
  let zone; // undefined = match by drop-off, null = everywhere, row = that zone
  if (b.zone_id !== undefined) {
    if (b.zone_id === null) zone = null;
    else {
      const z = await db("shipping_zones").where({ id: Number(b.zone_id), is_deleted: false }).first();
      if (!z) return res.status(404).json({ error: "Zone not found" });
      zone = presentZone(z);
    }
  }
  const dropoff = isPlainObject(b.dropoff) ? { lat: toNum(b.dropoff.lat), lng: toNum(b.dropoff.lng), pincode: b.dropoff.pincode } : undefined;

  const r = await shipping.compute({ kind: b.kind, distanceKm: distance, orderValue, at, dropoff, restaurant: restaurant || undefined, zone });
  if (r.fallback) {
    // No rule priced it: show what the real code path would charge (the legacy behaviour).
    let amount;
    if (b.kind === "customer_fee") amount = require("../services/routing.service").computeDeliveryFee(distance, restaurant || { radius_km: 0 });
    else { const riderPay = require("../services/riderPay.service"); amount = riderPay.computePayout({ distanceKm: distance, config: await riderPay.getCurrentConfig() }).payout; }
    return res.json({ amount, zone: r.zone, applied: [], breakdown: r.breakdown, warnings: r.warnings, fallback: true });
  }
  res.json({ amount: r.amount, zone: r.zone, applied: r.applied.map((a) => ({ rule_id: a.rule_id, name: a.name, type: a.type, effect: a.effect })), breakdown: r.breakdown, warnings: r.warnings, fallback: false });
}

module.exports = {
  listZones, createZone, updateZone, deleteZone, reorderZones,
  listRules, createRule, updateRule, deleteRule, reorderRules,
  history, preview, parseCharge, parseConditions, parseMatch,
};
