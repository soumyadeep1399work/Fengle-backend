const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

if (!JWT_SECRET) {
  // Fail loud at boot rather than silently signing tokens with `undefined`
  console.warn("[warn] JWT_SECRET is not set — set it in .env before going to production");
}

/**
 * @param {{id: number, type: 'customer'|'restaurant'|'rider'|'admin'}} payload
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken };
