const fs = require("fs");
const os = require("os");
const path = require("path");
const tls = require("tls");
const db = require("../config/db");
const push = require("./push.service");

/**
 * Admin "System health" (super_admin only): one read-only list of checks, each { key, group, label, status, summary, value?, details?, checked_at }.
 *   status: ok | warn | down | unknown   ("unknown" = cannot be checked from here, e.g. not configured or no permission - not a failure)
 *
 * Rules every check follows:
 *   - never returns a secret (no keys, tokens, signed URLs, file contents); error text goes through safeMessage()
 *   - runs in parallel with the others under a hard timeout (a hang becomes status "down", "No response in 5 s")
 *   - slow, rate-limited or BILLED checks are cached (Cost Explorer 24 h, Google Routes 1 h, ...) and ?refresh=1 never bypasses those
 *   - failures are cached for much less than successes, so a recovered service shows up quickly, but a billed call is never retried in a loop
 *
 * Every network/AWS call goes through the `probes` object so the tests can replace it (no real network in the suite).
 */

const CHECK_TIMEOUT_MS = 5000;
const MIN_REFRESH_GAP_MS = 20 * 1000; // ?refresh=1 cannot re-run a check more often than this (the page polling must not hammer anything)
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const GROUP_ORDER = ["server", "data", "messaging", "payments", "google", "domains", "aws"];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Error text that is safe to show: no long token-like strings, no newlines, short. */
function safeMessage(err) {
  const raw = err && (err.message || err.name || err.code) ? String(err.message || err.name || err.code) : String(err || "unknown error");
  return raw.replace(/\s+/g, " ").replace(/[A-Za-z0-9_\-+/=]{32,}/g, "…").slice(0, 140).trim();
}

const ok = (summary, extra = {}) => ({ status: "ok", summary, ...extra });
const warn = (summary, extra = {}) => ({ status: "warn", summary, ...extra });
const down = (summary, extra = {}) => ({ status: "down", summary, ...extra });
const unknown = (summary, extra = {}) => ({ status: "unknown", summary, ...extra });

const round = (n, dp = 1) => Number(Number(n).toFixed(dp));
const mb = (bytes) => round(bytes / (1024 * 1024), 0);

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  return `${m} m`;
}

/** ok / warn / down by a "higher is worse" percentage. */
function byPercent(pct, warnAt, downAt) {
  return pct > downAt ? "down" : pct > warnAt ? "warn" : "ok";
}

function withTimeout(promise, ms, label = "check") {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "down", summary: `No response in ${Math.round(ms / 1000)} s`, _timeout: true, _label: label }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// probes: everything that touches the outside world (replaced in tests)
// ---------------------------------------------------------------------------

const probes = {
  /** fetch with a timeout, parsed JSON (or null) alongside the status. Never throws for an HTTP error status. */
  async http(url, { method = "GET", headers = {}, body, timeoutMs = 4500 } = {}) {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, json };
  },

  /** The TLS certificate a host presents on 443: { valid_to (Date), authorized, authorization_error }. */
  tlsCertificate(host, timeoutMs = 4500) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        const result = { valid_to: cert && cert.valid_to ? new Date(cert.valid_to) : null, authorized: socket.authorized, authorization_error: socket.authorizationError ? String(socket.authorizationError) : null };
        socket.end();
        resolve(result);
      });
      socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error("TLS connection timed out")); });
      socket.on("error", (err) => reject(err));
    });
  },

  /**
   * Write then read back one tiny object on a bucket, and time both. One fixed key that is overwritten every time: the server's role
   * (PutObject/GetObject only, by design) is not allowed to delete, and one 20-byte object costs nothing.
   */
  async s3RoundTrip(bucket) {
    const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
    const client = require("./storage.service").getS3Client();
    const key = "_health/ping.txt";
    const stamp = `ok ${new Date().toISOString()}`;
    const t0 = Date.now();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: stamp, ContentType: "text/plain" }), { abortSignal: AbortSignal.timeout(4500) });
    const t1 = Date.now();
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(4500) });
    const text = await got.Body.transformToString();
    const t2 = Date.now();
    return { put_ms: t1 - t0, get_ms: t2 - t1, matches: text === stamp };
  },

  /** Month-to-date unblended cost in USD from Cost Explorer (a billed call, ~$0.01). Cost Explorer lives in us-east-1 whatever the region. */
  async monthToDateCost(now = new Date()) {
    const { CostExplorerClient, GetCostAndUsageCommand } = require("@aws-sdk/client-cost-explorer");
    const client = new CostExplorerClient({ region: "us-east-1" });
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)); // the end date is exclusive: include today
    const res = await client.send(new GetCostAndUsageCommand({ TimePeriod: { Start: iso(start), End: iso(end) }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"] }), { abortSignal: AbortSignal.timeout(4500) });
    const total = res.ResultsByTime && res.ResultsByTime[0] && res.ResultsByTime[0].Total && res.ResultsByTime[0].Total.UnblendedCost;
    if (!total) throw Object.assign(new Error("Cost Explorer returned no total"), { name: "NoData" });
    return { amount: Number(total.Amount), unit: total.Unit || "USD" };
  },

  readFile: (file) => fs.promises.readFile(file, "utf8"),
  statFile: (file) => fs.promises.stat(file),
  readdir: (dir) => fs.promises.readdir(dir),
  async diskUsage(where = "/") {
    if (typeof fs.promises.statfs === "function") {
      const s = await fs.promises.statfs(where);
      const total = s.blocks * s.bsize;
      const used = (s.blocks - s.bfree) * s.bsize; // the same figure `df` prints in "Use%": used / (used + available to a normal user)
      const availableToUser = s.bavail * s.bsize;
      return { total, used, pct: (used / (used + availableToUser)) * 100 };
    }
    // Node older than 18.15 has no statfs: ask df (POSIX output, 1 KB blocks).
    const out = await new Promise((resolve, reject) => require("child_process").execFile("df", ["-Pk", where], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    const cols = out.trim().split(/\r?\n/).pop().trim().split(/\s+/);
    const used = Number(cols[2]) * 1024, avail = Number(cols[3]) * 1024;
    return { total: Number(cols[1]) * 1024, used, pct: (used / (used + avail)) * 100 };
  },
};

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

async function checkMemory() {
  let total, available, swapTotal = 0, swapFree = 0;
  try {
    const info = await probes.readFile("/proc/meminfo");
    const kb = (name) => { const m = info.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, "m")); return m ? Number(m[1]) * 1024 : null; };
    total = kb("MemTotal"); available = kb("MemAvailable"); swapTotal = kb("SwapTotal") || 0; swapFree = kb("SwapFree") || 0;
  } catch (err) { /* not Linux: fall back below */ }
  if (!total || available == null) { total = os.totalmem(); available = os.freemem(); }

  const used = total - available;
  const pct = round((used / total) * 100, 0);
  const swapUsed = swapTotal - swapFree;
  const swapText = swapTotal ? `, swap ${mb(swapUsed)} of ${mb(swapTotal)} MB` : ", no swap";
  const status = byPercent(pct, 85, 95);
  return {
    status, value: pct, summary: `${pct}% used (${mb(used)} of ${mb(total)} MB)${swapText}`,
    details: { total_mb: mb(total), used_mb: mb(used), available_mb: mb(available), swap_total_mb: mb(swapTotal), swap_used_mb: mb(swapUsed), api_process_rss_mb: mb(process.memoryUsage().rss) },
  };
}

async function checkDisk() {
  const d = await probes.diskUsage("/");
  const pct = round(d.pct, 0);
  return {
    status: byPercent(pct, 80, 92), value: pct, summary: `${pct}% used (${round(d.used / 1073741824, 1)} of ${round(d.total / 1073741824, 1)} GB)`,
    details: { total_gb: round(d.total / 1073741824, 1), used_gb: round(d.used / 1073741824, 1), free_gb: round((d.total - d.used) / 1073741824, 1) },
  };
}

async function checkLoadUptime() {
  const [l1, l5, l15] = os.loadavg();
  const cpus = os.cpus().length || 1;
  const ratio = l5 / cpus;
  const status = ratio > 3 ? "down" : ratio > 1.5 ? "warn" : "ok";
  const details = {
    load_1m: round(l1, 2), load_5m: round(l5, 2), load_15m: round(l15, 2), cpu_count: cpus,
    system_uptime: fmtDuration(os.uptime()), api_process_uptime: fmtDuration(process.uptime()),
  };
  const restarts = Number(process.env.restart_time); // PM2 puts the process's restart count in its environment
  if (Number.isFinite(restarts)) details.api_restarts = restarts;
  return { status, value: round(l5, 2), summary: `Load ${round(l1, 2)} / ${round(l5, 2)} / ${round(l15, 2)} on ${cpus} CPU${cpus === 1 ? "" : "s"}, up ${fmtDuration(os.uptime())}`, details };
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

async function checkMysql() {
  const t0 = Date.now();
  await db.raw("select 1");
  const ping = Date.now() - t0;
  let sizeMb = null, tables = null;
  try {
    const [rows] = await db.raw("select coalesce(sum(data_length + index_length), 0) as bytes, count(*) as tables from information_schema.tables where table_schema = database()");
    const row = Array.isArray(rows) ? rows[0] : rows;
    sizeMb = round(Number(row.bytes) / (1024 * 1024), 1);
    tables = Number(row.tables);
  } catch (err) { /* size is a nice-to-have; the ping already proved the database is up */ }
  return {
    status: ping > 500 ? "warn" : "ok", value: ping,
    summary: `Answers in ${ping} ms${sizeMb != null ? `, database ${sizeMb} MB` : ""}`,
    details: { ping_ms: ping, database_size_mb: sizeMb, tables },
  };
}

function checkBucket(envName, label) {
  return async () => {
    const bucket = process.env[envName];
    if (!bucket) return unknown(`Not configured (${envName} is not set, so files stay on this server's disk)`);
    let r;
    try {
      r = await probes.s3RoundTrip(bucket);
    } catch (err) {
      const code = err && (err.name || err.Code || err.code) ? String(err.name || err.Code || err.code) : "error";
      return down(`${label}: could not write/read a test object (${code})`, { details: { error: safeMessage(err) } });
    }
    if (!r.matches) return down(`${label}: wrote a test object but read back something different`, { details: { write_ms: r.put_ms, read_ms: r.get_ms } });
    const slow = Math.max(r.put_ms, r.get_ms) > 2000;
    return {
      status: slow ? "warn" : "ok", value: r.put_ms + r.get_ms,
      summary: `Write ${r.put_ms} ms, read ${r.get_ms} ms`,
      details: { write_ms: r.put_ms, read_ms: r.get_ms, test_object: "_health/ping.txt (overwritten each time, never deleted)" },
    };
  };
}

// The backup script (~/fengle-backup/backup.sh) appends to backup.log. We only trust patterns, not an exact format, so a reworded log line
// does not silently turn this check green or red: a success marker, an error marker, and whatever timestamp the line carries.
const SUCCESS_RE = /(backup (done|complete|completed|ok|finished|succeeded)|upload(ed)? (ok|done|complete|verified)|uploaded|sha-?256.*(match|ok|verified)|\bdone\b)/i;
const ERROR_RE = /(error|fail(ed|ure)?|denied|no such file|cannot|can't|unable|not found)/i;

function parseLineTime(line) {
  let m = line.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (m) {
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(m[0]);
    const t = Date.parse(hasZone ? m[0].replace(" ", "T") : `${m[0].replace(" ", "T")}Z`); // the server runs in UTC; a zone-less stamp is read as UTC
    if (Number.isFinite(t)) return t;
  }
  m = line.match(/[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}(?: [A-Z]{2,5})? \d{4}/); // `date` style: Fri Oct 30 21:30:01 UTC 2026
  if (m) {
    const t = Date.parse(m[0]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Pure: decide the backup status from the log text. `fileMtimeMs` is used as the time of the final line when that line has no timestamp of its own.
 * Returns { status, summary, details } (no file size here: the caller adds it).
 */
function assessBackupLog(text, fileMtimeMs, nowMs = Date.now()) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  let lastSuccess = -1, lastError = -1;
  lines.forEach((line, i) => {
    if (SUCCESS_RE.test(line) && !/(error|fail)/i.test(line)) lastSuccess = i;
    else if (ERROR_RE.test(line)) lastError = i;
  });
  if (lastSuccess < 0) {
    return down(lines.length ? "No successful backup found in the log" : "The backup log is empty", { details: { last_line: lines.length ? lines[lines.length - 1].slice(0, 140) : null } });
  }
  let when = parseLineTime(lines[lastSuccess]);
  // A line with no stamp of its own: use the timestamp of the nearest earlier line of the same run, else the file's modified time when it is the last line.
  for (let i = lastSuccess - 1; when == null && i >= 0 && lastSuccess - i <= 8; i -= 1) when = parseLineTime(lines[i]);
  if (when == null && lastSuccess === lines.length - 1) when = fileMtimeMs;
  const erroredAfter = lastError > lastSuccess;
  const details = { last_success_line: lines[lastSuccess].slice(0, 140), last_run_errored: erroredAfter };
  if (erroredAfter) details.last_error_line = lines[lastError].slice(0, 140);
  if (when == null) return unknown("A backup finished, but the log has no time on it", { details });

  const ageH = (nowMs - when) / HOUR;
  details.last_success_at = new Date(when).toISOString();
  details.age_hours = round(ageH, 1);
  const status = erroredAfter || ageH > 50 ? "down" : ageH > 26 ? "warn" : "ok";
  const ago = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min ago` : `${round(ageH, 1)} h ago`;
  return { status, value: round(ageH, 1), summary: erroredAfter ? `The last run failed (last good backup ${ago})` : `Last backup ${ago}`, details };
}

async function checkBackup() {
  const dir = process.env.BACKUP_DIR || path.join(os.homedir(), "fengle-backup");
  const logFile = path.join(dir, "backup.log");
  let text, stat;
  try {
    // Only the tail matters (a nightly log grows slowly, but never read an unbounded file).
    stat = await probes.statFile(logFile);
    text = await probes.readFile(logFile);
  } catch (err) {
    return unknown("No backup log on this server", { details: { expected_log: "backup.log in the fengle-backup folder" } });
  }
  if (text.length > 200000) text = text.slice(-200000);
  const result = assessBackupLog(text, stat.mtimeMs);

  // The size of the newest local dump (the script keeps the last 7 in ./dumps).
  try {
    const dumpsDir = path.join(dir, "dumps");
    const files = (await probes.readdir(dumpsDir)).filter((f) => /\.(gz|sql)$/i.test(f));
    let newest = null;
    for (const f of files) {
      const s = await probes.statFile(path.join(dumpsDir, f));
      if (!newest || s.mtimeMs > newest.mtimeMs) newest = { size: s.size, mtimeMs: s.mtimeMs };
    }
    if (newest) {
      result.details = { ...(result.details || {}), latest_dump_kb: round(newest.size / 1024, 0), local_dumps_kept: files.length };
      if (result.summary && result.status !== "down") result.summary += `, ${round(newest.size / 1024, 0)} KB`;
    }
  } catch (err) { /* no dumps folder: the size is just left out */ }
  return result;
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

async function checkFast2Sms() {
  const key = process.env.FAST2SMS_API_KEY;
  if (!key) return unknown("Not configured (no Fast2SMS key, so OTPs are only logged)");
  let r;
  try {
    r = await probes.http("https://www.fast2sms.com/dev/wallet", { headers: { authorization: key } });
  } catch (err) {
    return down("Could not reach Fast2SMS", { details: { error: safeMessage(err) } });
  }
  const balance = r.json && r.json.wallet != null ? Number(r.json.wallet) : NaN;
  if (!r.ok || !r.json || r.json.return !== true || !Number.isFinite(balance)) {
    const rejected = r.status === 401 || r.status === 403 || r.status === 412 || /authori[sz]ation|invalid.*key/i.test(String((r.json && r.json.message) || ""));
    return down(rejected ? "Fast2SMS rejected the API key" : `Fast2SMS did not return a balance (HTTP ${r.status})`, { details: { message: safeMessage((r.json && r.json.message) || `HTTP ${r.status}`) } });
  }
  // Fast2SMS reports sms_count with the wallet: how many SMS the balance covers at the account's own slab rate. That is what actually runs
  // out, so it drives the status. Without it (an older/changed response) fall back to the rupee balance, and to FAST2SMS_RATE_PER_SMS for the estimate.
  const reported = r.json.sms_count != null ? Number(r.json.sms_count) : NaN;
  const hasCount = Number.isFinite(reported) && reported >= 0;
  const rate = Number(process.env.FAST2SMS_RATE_PER_SMS);
  const smsLeft = hasCount ? Math.floor(reported) : Number.isFinite(rate) && rate > 0 ? Math.floor(balance / rate) : null;
  const status = hasCount ? (reported < 200 ? "down" : reported < 800 ? "warn" : "ok") : balance < 50 ? "down" : balance < 200 ? "warn" : "ok";
  const money = `₹${balance.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return {
    status, value: round(balance, 2), summary: smsLeft != null ? `${money} left (~${smsLeft.toLocaleString("en-IN")} SMS)` : `${money} left`,
    details: { balance_rupees: round(balance, 2), sms_left: smsLeft, sms_left_source: hasCount ? "reported by Fast2SMS" : smsLeft != null ? "estimated from FAST2SMS_RATE_PER_SMS" : null },
  };
}

async function checkPush() {
  const h = await push.health();
  const s = h.stats;
  const details = {
    fcm_configured: h.fcm.configured, fcm_login_ok: h.fcm.auth_ok, expo_access_token_set: h.expo_access_token_set,
    sent_last_24h: s.sent, failed_last_24h: s.failed, dead_tokens_removed_last_24h: s.dead_tokens,
    counted_over_hours: s.window_hours, counters_note: "Counted since the server last restarted, up to 24 h",
    last_error: s.last_error, last_error_at: s.last_error_at,
  };
  try { details.registered_devices = Number((await db("device_tokens").count({ n: "*" }).first()).n); } catch (err) { /* nice to have */ }

  const prod = process.env.NODE_ENV === "production";
  if (!h.fcm.configured) return { status: prod ? "down" : "unknown", summary: prod ? "FCM is not configured: no push notifications are being sent" : "FCM is not configured (fine on a dev machine)", details };
  if (!h.fcm.auth_ok) return down("Cannot sign in to Firebase (FCM)", { details: { ...details, error: h.fcm.error } });
  const attempts = s.sent + s.failed;
  const failRate = attempts ? s.failed / attempts : 0;
  const bad = s.failed >= 5 && failRate >= 0.25;
  return {
    status: bad ? "warn" : "ok", value: s.failed,
    summary: attempts ? `${s.sent} sent, ${s.failed} failed in the last ${s.window_hours >= 24 ? "24 h" : `${s.window_hours} h`}` : "FCM is set up and signed in; nothing sent yet since the last restart",
    details,
  };
}

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

async function checkRazorpay() {
  const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  const prod = process.env.NODE_ENV === "production";
  if (!id || !secret) return { status: prod ? "down" : "unknown", summary: prod ? "No Razorpay keys: online payments auto-succeed" : "Not configured (payments auto-succeed on a dev machine)" };
  const mode = id.startsWith("rzp_live_") ? "live" : id.startsWith("rzp_test_") ? "test" : "unknown";
  const webhook = Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
  let r;
  try {
    r = await probes.http("https://api.razorpay.com/v1/payments?count=1", { headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` } });
  } catch (err) {
    return down("Could not reach Razorpay", { details: { mode, webhook_secret_configured: webhook, error: safeMessage(err) } });
  }
  const details = { mode, webhook_secret_configured: webhook };
  if (r.status === 401 || r.status === 403) return down("Razorpay rejected the keys", { details });
  if (!r.ok) return down(`Razorpay answered HTTP ${r.status}`, { details: { ...details, message: safeMessage(r.json && r.json.error && r.json.error.description) } });
  if (!webhook) return warn(`Keys valid (${mode} mode), but the webhook secret is not set`, { details });
  return ok(`Keys valid (${mode} mode), webhook secret set`, { details });
}

// ---------------------------------------------------------------------------
// google
// ---------------------------------------------------------------------------

async function checkGoogleRoutes() {
  const key = (process.env.GOOGLE_ROUTES_API_KEY || "").trim();
  if (!key) return unknown("No Routes key set: delivery distances use straight-line estimates");
  const t0 = Date.now();
  let r;
  try {
    // One tiny route inside Kolkata, distance field only (the cheapest SKU). This is a billed call, which is why the result is cached for an hour.
    r = await probes.http("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters" },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: 22.5726, longitude: 88.3639 } } },
        destination: { location: { latLng: { latitude: 22.58, longitude: 88.37 } } },
        travelMode: "DRIVE",
      }),
    });
  } catch (err) {
    return down("Could not reach the Google Routes API", { details: { error: safeMessage(err) } });
  }
  const ms = Date.now() - t0;
  if (r.ok && r.json && Array.isArray(r.json.routes) && r.json.routes.length) return { status: "ok", value: ms, summary: `Routes key works (${ms} ms)`, details: { latency_ms: ms } };
  const e = (r.json && r.json.error) || {};
  const reason = [e.status, e.message].filter(Boolean).join(": ") || `HTTP ${r.status}`;
  return down(`Routes call failed: ${safeMessage({ message: reason })}`, { details: { http_status: r.status, google_status: e.status || null } });
}

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------

function sslCheck(host) {
  return async () => {
    let c;
    try {
      c = await probes.tlsCertificate(host);
    } catch (err) {
      return down(`Could not open a secure connection to ${host}`, { details: { error: safeMessage(err) } });
    }
    if (!c.valid_to || Number.isNaN(c.valid_to.getTime())) return unknown("Certificate has no expiry date");
    const days = Math.floor((c.valid_to.getTime() - Date.now()) / 86400000);
    const details = { expires_on: c.valid_to.toISOString().slice(0, 10), days_left: days, trusted: c.authorized };
    if (!c.authorized) { details.trust_problem = safeMessage(c.authorization_error); return down(`Certificate is not trusted (${safeMessage(c.authorization_error)})`, { value: days, details }); }
    if (days < 0) return down(`Certificate expired ${-days} day${days === -1 ? "" : "s"} ago`, { value: days, details });
    return { status: days < 7 ? "down" : days < 20 ? "warn" : "ok", value: days, summary: `Expires in ${days} days (${details.expires_on})`, details };
  };
}

async function checkDomainRegistration() {
  const domain = process.env.HEALTH_DOMAIN || "fengle.in";
  // The .in registry (NIXI) answers RDAP directly, no registrar API or login needed; rdap.org is a public redirector used as the fallback.
  const urls = [`https://rdap.nixiregistry.in/rdap/domain/${domain}`, `https://rdap.org/domain/${domain}`];
  let json = null, lastErr = null;
  for (const url of urls) {
    try {
      const r = await probes.http(url, { headers: { Accept: "application/rdap+json" }, timeoutMs: 2200 });
      if (r.ok && r.json) { json = r.json; break; }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (err) { lastErr = err; }
  }
  if (!json) return down("Could not read the domain registration (RDAP)", { details: { error: safeMessage(lastErr) } });
  const event = (name) => (Array.isArray(json.events) ? json.events.find((e) => e.eventAction === name) : null);
  const exp = event("expiration");
  const when = exp && Date.parse(exp.eventDate);
  if (!Number.isFinite(when)) return unknown("The registry did not return an expiry date");
  const days = Math.floor((when - Date.now()) / 86400000);
  const reg = event("registration");
  const details = { domain, expires_on: new Date(when).toISOString().slice(0, 10), days_left: days, registrar: (reg && reg.eventActor) || null, status: Array.isArray(json.status) ? json.status.join(", ") : null };
  if (days < 0) return down(`${domain} expired ${-days} days ago`, { value: days, details });
  return { status: days < 7 ? "down" : days < 30 ? "warn" : "ok", value: days, summary: `${domain} renews by ${details.expires_on} (${days} days)`, details };
}

// ---------------------------------------------------------------------------
// aws
// ---------------------------------------------------------------------------

async function checkAwsCost() {
  const now = new Date();
  let cost;
  try {
    cost = await probes.monthToDateCost(now);
  } catch (err) {
    const name = String((err && (err.name || err.Code || err.code)) || "");
    if (/AccessDenied|UnauthorizedOperation|AuthFailure|UnrecognizedClient/i.test(name) || /not authorized|access denied/i.test(String(err && err.message))) {
      return unknown("Needs the ce:GetCostAndUsage permission", { details: { hint: "Allow ce:GetCostAndUsage on the server's IAM role. If it is still denied, the root user must switch on 'IAM user and role access to Billing information' (Account page)." } });
    }
    if (/Credential|CredentialsProvider|Could not load credentials|NoCredentials/i.test(name + " " + String(err && err.message))) return unknown("This server has no AWS credentials to ask for the cost");
    if (/DataUnavailable|NoData/i.test(name)) return unknown("Cost Explorer has no data yet (it is switched on in the Billing console and fills in within a day)");
    return down(`Cost Explorer call failed (${name || "error"})`, { details: { error: safeMessage(err) } });
  }
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = day > 0 ? (cost.amount / day) * daysInMonth : null;
  const symbol = cost.unit === "USD" ? "$" : `${cost.unit} `;
  const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const warnAt = Number(process.env.HEALTH_COST_WARN_USD);
  const status = Number.isFinite(warnAt) && warnAt > 0 && (projected || cost.amount) > warnAt ? "warn" : "ok";
  return {
    status, value: round(cost.amount, 2), summary: `${symbol}${round(cost.amount, 2)} so far in ${month}`,
    details: {
      month_to_date: round(cost.amount, 2), currency: cost.unit, days_elapsed: day,
      month_end_estimate: projected != null ? round(projected, 2) : null, estimate_note: "Straight-line from the average so far; Cost Explorer lags by up to a day",
    },
  };
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

const SSL_HOSTS = () => (process.env.HEALTH_SSL_HOSTS ? process.env.HEALTH_SSL_HOSTS.split(",").map((h) => h.trim()).filter(Boolean) : ["fengle.in", "api.fengle.in", "admin.fengle.in", "partner.fengle.in"]);

/**
 * ttl: how long a good result is reused. failTtl: how long a down/unknown one is. refreshable: ?refresh=1 may re-run it.
 * Billed checks (aws.cost_mtd, google.routes) are never refreshable.
 */
function definitions() {
  const defs = [
    { key: "server.memory", group: "server", label: "Memory", run: checkMemory, ttl: 15000, failTtl: 15000, refreshable: true },
    { key: "server.disk", group: "server", label: "Disk space", run: checkDisk, ttl: 60000, failTtl: 15000, refreshable: true },
    { key: "server.load_uptime", group: "server", label: "CPU load and uptime", run: checkLoadUptime, ttl: 15000, failTtl: 15000, refreshable: true },
    { key: "data.mysql", group: "data", label: "Database (MySQL)", run: checkMysql, ttl: 15000, failTtl: 5000, refreshable: true },
    { key: "data.s3_uploads", group: "data", label: "File storage (uploads)", run: checkBucket("AWS_S3_BUCKET", "Uploads bucket"), ttl: 60000, failTtl: 15000, refreshable: true },
    { key: "data.s3_private", group: "data", label: "File storage (private documents)", run: checkBucket("AWS_S3_PRIVATE_BUCKET", "Private bucket"), ttl: 60000, failTtl: 15000, refreshable: true },
    { key: "data.backup", group: "data", label: "Database backup", run: checkBackup, ttl: 60000, failTtl: 30000, refreshable: true },
    { key: "messaging.fast2sms_wallet", group: "messaging", label: "SMS balance (Fast2SMS)", run: checkFast2Sms, ttl: 10 * MIN, failTtl: MIN, refreshable: true },
    { key: "messaging.push", group: "messaging", label: "Push notifications", run: checkPush, ttl: 60000, failTtl: 30000, refreshable: true },
    { key: "payments.razorpay", group: "payments", label: "Razorpay", run: checkRazorpay, ttl: 10 * MIN, failTtl: MIN, refreshable: true },
    { key: "google.routes", group: "google", label: "Google Routes (road distance)", run: checkGoogleRoutes, ttl: HOUR, failTtl: 5 * MIN, refreshable: false },
  ];
  for (const host of SSL_HOSTS()) {
    defs.push({ key: `domains.ssl_${host.replace(/[^a-z0-9]+/gi, "_")}`, group: "domains", label: `HTTPS certificate: ${host}`, run: sslCheck(host), ttl: 6 * HOUR, failTtl: 5 * MIN, refreshable: false });
  }
  defs.push(
    { key: "domains.registration", group: "domains", label: "Domain registration", run: checkDomainRegistration, ttl: 24 * HOUR, failTtl: 10 * MIN, refreshable: false },
    { key: "aws.cost_mtd", group: "aws", label: "AWS cost this month", run: checkAwsCost, ttl: 24 * HOUR, failTtl: 10 * MIN, refreshable: false },
  );
  return defs;
}

const cache = new Map(); // key -> { result, at, expires }
const inflight = new Map(); // key -> Promise (so two viewers at once share one run)

function clearCache() { cache.clear(); inflight.clear(); }

async function runOne(def, refresh, now = Date.now()) {
  const hit = cache.get(def.key);
  if (hit && now < hit.expires && !(refresh && def.refreshable && now - hit.at >= MIN_REFRESH_GAP_MS)) return hit.result;
  if (inflight.has(def.key)) return inflight.get(def.key);

  const job = (async () => {
    let body;
    try {
      body = await withTimeout(Promise.resolve().then(def.run), CHECK_TIMEOUT_MS, def.key);
    } catch (err) {
      body = down(`Check failed: ${safeMessage(err)}`);
    }
    const at = new Date().toISOString();
    const result = {
      key: def.key, group: def.group, label: def.label,
      status: ["ok", "warn", "down", "unknown"].includes(body.status) ? body.status : "unknown",
      summary: String(body.summary || ""),
      value: body.value != null && Number.isFinite(Number(body.value)) ? Number(body.value) : null,
      ...(body.details ? { details: cleanDetails(body.details) } : {}),
      checked_at: at,
    };
    const good = result.status === "ok" || result.status === "warn";
    cache.set(def.key, { result, at: Date.now(), expires: Date.now() + (good ? def.ttl : def.failTtl) });
    return result;
  })().finally(() => inflight.delete(def.key));
  inflight.set(def.key, job);
  return job;
}

/** details must be flat { label: string | number | boolean | null }. */
function cleanDetails(details) {
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (v == null) out[k] = null;
    else if (typeof v === "number") out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === "boolean") out[k] = v;
    else out[k] = String(v).slice(0, 200);
  }
  return out;
}

/** { checked_at, overall, checks: [...] } in group order. */
async function run({ refresh = false } = {}) {
  const defs = definitions();
  const checks = await Promise.all(defs.map((d) => runOne(d, refresh)));
  checks.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)); // stable: keeps the order within a group
  const statuses = checks.map((c) => c.status);
  return { checked_at: new Date().toISOString(), overall: statuses.includes("down") ? "down" : statuses.includes("warn") ? "warn" : "ok", checks };
}

module.exports = { run, probes, clearCache, withTimeout, safeMessage, assessBackupLog, parseLineTime, definitions, CHECK_TIMEOUT_MS, GROUP_ORDER };
