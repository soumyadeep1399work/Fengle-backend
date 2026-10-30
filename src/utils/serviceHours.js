const { OFFSET_MIN } = require("./reportRange");

/**
 * Kitchen service hours: ONE daily window per kitchen (same every day), in IST (REPORT_TZ_OFFSET_MINUTES).
 * restaurants.opens_at / closes_at are TIME columns; both NULL = always open. closes_at earlier than opens_at is an overnight
 * window (e.g. 18:00 -> 02:00). opens_at === closes_at is rejected on write (it would mean "never" or "always" depending on taste).
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAY_MIN = 24 * 60;

/** "HH:MM" or "HH:MM:SS" (what MySQL returns for TIME) -> minutes since midnight, or null if not a time. */
function toMinutes(value) {
  if (value === null || value === undefined) return null;
  const m = HHMM.exec(String(value).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** minutes since midnight -> "HH:MM" */
function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Normalises a stored TIME ("19:00:00") to "HH:MM", or null. */
function normaliseTime(value) {
  const min = toMinutes(value);
  return min === null ? null : toHHMM(min);
}

/** Minutes since midnight in the business timezone for an instant. */
function nowMinutesIst(now = new Date()) {
  const shifted = new Date(now.getTime() + OFFSET_MIN * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** True when the kitchen has a window set. */
function hasHours(restaurant) {
  return toMinutes(restaurant.opens_at) !== null && toMinutes(restaurant.closes_at) !== null;
}

function isOpenNow(restaurant, now = new Date()) {
  const opens = toMinutes(restaurant.opens_at);
  const closes = toMinutes(restaurant.closes_at);
  if (opens === null || closes === null) return true; // no hours = always open
  const t = nowMinutesIst(now);
  if (opens < closes) return t >= opens && t < closes;
  if (opens > closes) return t >= opens || t < closes; // overnight
  return true; // equal can't be stored; treat a stray one as always open rather than never
}

/** Minutes until the kitchen next opens (0 if open now, null if it has no hours). */
function minutesUntilOpen(restaurant, now = new Date()) {
  if (!hasHours(restaurant)) return null;
  if (isOpenNow(restaurant, now)) return 0;
  return (toMinutes(restaurant.opens_at) - nowMinutesIst(now) + DAY_MIN) % DAY_MIN;
}

/**
 * Of these kitchens, "closed" is true when none is open right now (and there is at least one); opens_at is the earliest
 * next opening ("HH:MM") among them. closed:false -> opens_at null.
 */
function openStatus(restaurants, now = new Date()) {
  if (restaurants.length === 0 || restaurants.some((r) => isOpenNow(r, now))) return { closed: false, opens_at: null };
  let best = null;
  for (const r of restaurants) {
    const wait = minutesUntilOpen(r, now);
    if (best === null || wait < best.wait) best = { wait, opens_at: normaliseTime(r.opens_at) };
  }
  return { closed: true, opens_at: best ? best.opens_at : null };
}

/** "19:00" -> "7:00 PM" for customer-facing text. */
function friendlyTime(hhmm) {
  const min = toMinutes(hhmm);
  if (min === null) return String(hhmm);
  const h = Math.floor(min / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function closedMessage(opensAt) {
  return opensAt ? `This kitchen is closed right now. It opens at ${friendlyTime(opensAt)}.` : "This kitchen is closed right now.";
}

/**
 * Validates an admin's { opens_at, closes_at } patch (either may be omitted). Both null clears the hours; setting only one of the
 * pair is rejected, as is opens_at === closes_at. `current` is the stored row, so patching one field can still be checked against
 * the other. Returns { error } or { value: { opens_at, closes_at } } ("HH:MM" or null each), or { value: null } if nothing was given.
 */
function validateHoursPatch(body, current) {
  const has = (k) => body[k] !== undefined;
  if (!has("opens_at") && !has("closes_at")) return { value: null };
  const parse = (k) => {
    const v = body[k];
    if (v === null || v === "") return { ok: true, value: null };
    if (typeof v !== "string" || !HHMM.test(v.trim())) return { ok: false };
    return { ok: true, value: normaliseTime(v.trim()) };
  };
  const o = has("opens_at") ? parse("opens_at") : { ok: true, value: normaliseTime(current.opens_at) };
  const c = has("closes_at") ? parse("closes_at") : { ok: true, value: normaliseTime(current.closes_at) };
  if (!o.ok) return { error: "opens_at must be a time like 09:30 (24-hour HH:MM) or null" };
  if (!c.ok) return { error: "closes_at must be a time like 22:00 (24-hour HH:MM) or null" };
  if ((o.value === null) !== (c.value === null)) return { error: "Set both opens_at and closes_at, or clear both (a kitchen with no hours is always open)" };
  if (o.value !== null && o.value === c.value) return { error: "opens_at and closes_at can't be the same time" };
  return { value: { opens_at: o.value, closes_at: c.value } };
}

/** Adds opens_at/closes_at ("HH:MM") and is_open_now to a restaurant row for admin responses. */
function presentHours(restaurant, now = new Date()) {
  return { ...restaurant, opens_at: normaliseTime(restaurant.opens_at), closes_at: normaliseTime(restaurant.closes_at), is_open_now: isOpenNow(restaurant, now) };
}

module.exports = { toMinutes, normaliseTime, nowMinutesIst, hasHours, isOpenNow, minutesUntilOpen, openStatus, friendlyTime, closedMessage, validateHoursPatch, presentHours };
