const { verifyToken } = require("../utils/jwt");

/**
 * Verifies the JWT and attaches `req.auth = { id, type }`.
 * @param {Array<'customer'|'restaurant'|'rider'|'admin'>} [allowedTypes] - restrict to specific user types
 */
function requireAuth(allowedTypes) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    try {
      const decoded = verifyToken(token);
      if (allowedTypes && !allowedTypes.includes(decoded.type)) {
        return res.status(403).json({ error: "Not authorized for this resource" });
      }
      req.auth = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

module.exports = { requireAuth };
