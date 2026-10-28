// Date ranges for admin reports (COD reconciliation, P&L). The business runs in Kolkata, so a
// date-only value like "2026-10-28" means that IST calendar day, not a UTC day — otherwise an order
// placed at 11 pm IST would land in the wrong day depending on where the server clock is.
// REPORT_TZ_OFFSET_MINUTES defaults to 330 (IST).
const envOffset = process.env.REPORT_TZ_OFFSET_MINUTES;
const OFFSET_MIN = envOffset !== undefined && envOffset !== "" && Number.isFinite(Number(envOffset)) ? Number(envOffset) : 330;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start of that calendar day in the report timezone, as a real instant. */
function startOfDay(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MIN * 60000);
}

/**
 * Parses ?from= and ?to= (both optional). Date-only values cover whole report-timezone days
 * (from = start of that day, to = the very end of that day); full ISO date-times are used as given.
 * Returns { from, to } (Date or null) or { error }.
 */
function parseRange(query) {
  const out = { from: null, to: null };
  for (const key of ["from", "to"]) {
    const raw = query[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const m = DATE_ONLY.exec(String(raw));
    let date;
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      date = startOfDay(y, mo, d);
      if (Number.isNaN(date.getTime()) || new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() !== mo - 1) return { error: `${key} is not a valid date` };
      if (key === "to") date = new Date(date.getTime() + DAY_MS - 1);
    } else {
      date = new Date(raw);
      if (Number.isNaN(date.getTime())) return { error: `${key} must be a date (YYYY-MM-DD) or an ISO date-time` };
    }
    out[key] = date;
  }
  if (out.from && out.to && out.from > out.to) return { error: "from must not be after to" };
  return out;
}

/** The report-timezone calendar day (YYYY-MM-DD) an instant falls on. */
function dayKey(date) {
  return new Date(new Date(date).getTime() + OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** The report-timezone month (YYYY-MM) an instant falls on. */
function monthKey(date) {
  return dayKey(date).slice(0, 7);
}

module.exports = { parseRange, dayKey, monthKey, OFFSET_MIN };
