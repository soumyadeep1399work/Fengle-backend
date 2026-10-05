const db = require("../config/db");
const { verifyToken } = require("../utils/jwt");

const PARTNER_TABLES = { restaurant: "restaurants", rider: "riders" };

/**
 * Verifies the JWT and attaches `req.auth = { id, type }`.
 *
 * Restaurant and rider tokens are additionally held to the admin's selfie
 * review: until `verification_status` is 'approved' every route that uses this
 * middleware answers 403 { code: "verification_required" } — secure by default,
 * so a new partner route can't forget the gate. Only the routes a partner
 * needs to get verified (profile read, accept-agreement, session, push-token
 * registration) opt out with `{ allowUnverified: true }`.
 *
 * @param {Array<'customer'|'restaurant'|'rider'|'admin'>} [allowedTypes] - restrict to specific user types
 * @param {{ allowUnverified?: boolean }} [options]
 */
function requireAuth(allowedTypes, { allowUnverified = false } = {}) {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    if (allowedTypes && !allowedTypes.includes(decoded.type)) {
      return res.status(403).json({ error: "Not authorized for this resource" });
    }

    // Admins are re-read from the DB on every request (not trusted from the 30-day JWT): a disabled
    // admin is locked out immediately, and a role change applies on the very next call.
    if (decoded.type === "admin") {
      try {
        const admin = await db("admins").where({ id: decoded.id }).select("role", "is_active").first();
        if (!admin) return res.status(401).json({ error: "Invalid or expired token" });
        if (!admin.is_active) {
          return res.status(401).json({ error: "This admin account has been disabled", code: "account_disabled" });
        }
        decoded.role = admin.role;
      } catch (err) {
        return next(err);
      }
    }

    const partnerTable = PARTNER_TABLES[decoded.type];
    if (partnerTable && !allowUnverified) {
      try {
        const row = await db(partnerTable).where({ id: decoded.id }).select("verification_status", "verification_denied_reason").first();
        if (!row) return res.status(401).json({ error: "Invalid or expired token" });
        if (row.verification_status !== "approved") {
          return res.status(403).json({
            error:
              row.verification_status === "denied"
                ? "Your verification photo was not approved. Please retake it."
                : "Your account is waiting for admin approval.",
            code: "verification_required",
            verificationStatus: row.verification_status,
            verificationDeniedReason: row.verification_denied_reason,
          });
        }
      } catch (err) {
        return next(err);
      }
    }

    req.auth = decoded;
    next();
  };
}

/**
 * Role gate for admin accounts, used after requireAuth. Non-admin tokens pass
 * straight through, so it can sit on routes that restaurants share (POST /items,
 * POST /uploads/image) without affecting them.
 * @param {...('super_admin'|'ops'|'support')} roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.auth && req.auth.type === "admin" && !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Your role doesn't allow this action", code: "forbidden_role" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
