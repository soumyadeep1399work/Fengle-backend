const crypto = require("crypto");

/**
 * Short-lived signed tokens for download links the phone opens in its browser (which can't send an Authorization header).
 * The token carries the exact request (who, what, which parameters) and an expiry, signed with HMAC-SHA256, so it can't be edited
 * to fetch anything else or reused after it expires. The key is derived from DOWNLOAD_URL_SECRET, else JWT_SECRET.
 */

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function key() {
  const secret = process.env.DOWNLOAD_URL_SECRET || process.env.JWT_SECRET || "dev-only-download-secret";
  return crypto.createHash("sha256").update(`signed-download:${secret}`).digest();
}

const mac = (body) => b64(crypto.createHmac("sha256", key()).update(body).digest());

/** A token for `payload`, valid for ttlSeconds. */
function sign(payload, ttlSeconds) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${mac(body)}`;
}

/** The payload if the token is genuine and not expired, else null. */
function verify(token) {
  if (typeof token !== "string") return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload && typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
