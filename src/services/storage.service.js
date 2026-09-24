// Image storage behind one small contract so production can move to S3
// (CLAUDE.md tech stack) by replacing saveImage only — callers depend on
// nothing but the returned { publicPath }.
//
// Dev: files go to fengle-backend/uploads/ and are served by app.js at
// /uploads. File names are always random UUIDs; the client's file name is
// never used (no path tricks, no collisions, nothing to guess).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Identifies an image by its leading bytes ("magic numbers") — the client's
 * Content-Type and file name are attacker-controlled, so they're ignored.
 * Only JPEG, PNG and WebP are accepted (deliberately not SVG, which can carry
 * script). Returns the file extension to store under, or null.
 */
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** Saves an already-validated image buffer; resolves { name, publicPath }. */
async function saveImage(buffer, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buffer, { flag: "wx" });
  return { name, publicPath: `/uploads/${name}` };
}

module.exports = { UPLOAD_DIR, detectImageType, saveImage };
