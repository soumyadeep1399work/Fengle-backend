const db = require("../config/db");
const reports = require("../services/kitchenReports.service");
const files = require("../services/kitchenReportFiles.service");
const signedUrl = require("../utils/signedUrl");
const { dayKey } = require("../utils/reportRange");

const DOWNLOAD_TTL_SECONDS = 300;
const MAX_LEDGER_DAYS = 366;

/**
 * GET /restaurants/me/sales?period=day|week|month&date=YYYY-MM-DD -> the kitchen's own sales and earnings (day-level only; see
 * kitchenReports.service.js for every definition). `date` defaults to today in IST; a week is Monday-Sunday.
 */
async function sales(req, res) {
  const period = req.query.period || "day";
  if (!["day", "week", "month"].includes(period)) return res.status(400).json({ error: "period must be day, week or month" });
  const date = req.query.date || dayKey(new Date());
  if (!reports.isValidDate(date)) return res.status(400).json({ error: "date must be a real date like 2026-11-08" });
  res.json(await reports.salesReport(req.auth.id, period, date));
}

/** GET /restaurants/me/payouts?page=&limit= -> the all-time payout position plus payment and adjustment history, newest first. */
async function payouts(req, res) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  res.json(await reports.payoutsPage(req.auth.id, { page, limit }));
}

/** Checks a download request and returns { error, status } or { params } with only the fields that kind needs. */
async function validateDownload(restaurantId, body) {
  const { kind, format } = body || {};
  if (!["sales", "ledger", "settlement"].includes(kind)) return { status: 400, error: "kind must be sales, ledger or settlement" };
  if (!["pdf", "csv"].includes(format)) return { status: 400, error: "format must be pdf or csv" };

  if (kind === "sales") {
    const period = body.period || "day";
    if (!["day", "week", "month"].includes(period)) return { status: 400, error: "period must be day, week or month" };
    const date = body.date || dayKey(new Date());
    if (!reports.isValidDate(date)) return { status: 400, error: "date must be a real date like 2026-11-08" };
    return { params: { period, date } };
  }
  if (kind === "ledger") {
    const { from, to } = body;
    if (!reports.isValidDate(from) || !reports.isValidDate(to)) return { status: 400, error: "from and to must be real dates like 2026-11-08" };
    if (from > to) return { status: 400, error: "from must not be after to" };
    if (reports.eachDay(from, to).length > MAX_LEDGER_DAYS) return { status: 400, error: `The range can be at most ${MAX_LEDGER_DAYS} days` };
    return { params: { from, to } };
  }
  const id = Number(body.payment_id);
  const payment = Number.isInteger(id) ? await db("restaurant_payments").where({ id, restaurant_id: restaurantId }).first("id") : null;
  if (!payment) return { status: 404, error: "Payment not found" };
  return { params: { payment_id: id } };
}

/**
 * POST /restaurants/me/downloads { kind: sales|ledger|settlement, format: pdf|csv, period?, date?, from?, to?, payment_id? }
 * -> { url, filename, expires_in_seconds }: an absolute link, signed for this kitchen and exactly this request, valid 5 minutes, that the
 * phone's browser can open without an Authorization header (GET /downloads?t=...). The file is built when the link is opened.
 */
async function createDownload(req, res) {
  const v = await validateDownload(req.auth.id, req.body);
  if (v.error) return res.status(v.status).json({ error: v.error });
  const { kind, format } = req.body;
  const built = await files.build({ restaurantId: req.auth.id, kind, format, params: v.params }); // built once now to get the filename and to refuse an impossible request early
  if (!built) return res.status(404).json({ error: "Nothing to download" });
  const token = signedUrl.sign({ r: req.auth.id, k: kind, f: format, p: v.params }, DOWNLOAD_TTL_SECONDS);
  // PUBLIC_API_URL ("https://api.fengle.in", with or without /api/v1) wins; otherwise the host this request came in on (trust proxy is on).
  const origin = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  res.json({ url: `${origin}/api/v1/downloads?t=${encodeURIComponent(token)}`, filename: built.filename, expires_in_seconds: DOWNLOAD_TTL_SECONDS });
}

/** GET /downloads?t=<token> — public by design (the token IS the authorisation); rebuilds the file the token was signed for. */
async function download(req, res) {
  const payload = signedUrl.verify(req.query.t);
  if (!payload || !payload.r || !payload.k || !payload.f || !payload.p) return res.status(403).json({ error: "This download link is invalid or has expired. Please request it again." });
  const built = await files.build({ restaurantId: payload.r, kind: payload.k, format: payload.f, params: payload.p });
  if (!built) return res.status(404).json({ error: "Nothing to download" });
  res.set("Content-Type", built.contentType);
  res.set("Content-Disposition", `attachment; filename="${built.filename}"`);
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.send(built.buffer);
}

module.exports = { sales, payouts, createDownload, download };
