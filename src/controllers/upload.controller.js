const storage = require("../services/storage.service");
const { toWebp } = require("../services/imageProcess.service");

/**
 * POST /uploads/image — multipart/form-data with one file field, `image`.
 * multer (see upload.routes.js) has already enforced the size cap and single
 * file; this validates the bytes really are a JPEG/PNG/WebP, re-encodes them as a
 * resized WebP (see imageProcess.service.js) and stores that — so the stored
 * object, and the returned URL, is always a .webp whatever was sent.
 *
 * The returned URL is absolute. When AWS_S3_BUCKET is set, storage.saveImage
 * uploads to S3 and returns the final object URL directly. Otherwise (dev
 * disk fallback) it's built from PUBLIC_BASE_URL if set (use this whenever
 * the backend is reached through a proxy or a fixed LAN IP), else the
 * request's own protocol + Host, which is what a phone on the LAN used to
 * reach us. Note the URL is stored verbatim in items.image_url, so in dev
 * set PUBLIC_BASE_URL to an address every device can reach — a URL built
 * from an emulator-only host like 10.0.2.2 won't load on a real phone.
 */
async function uploadImage(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "An image file is required (multipart/form-data, field name 'image')" });
  }

  const ext = storage.detectImageType(req.file.buffer);
  if (!ext) {
    return res.status(400).json({ error: "Only JPEG, PNG or WebP images are accepted" });
  }

  let webp;
  try {
    webp = await toWebp(req.file.buffer);
  } catch (err) {
    // Right magic bytes but undecodable (truncated, corrupt) or absurdly large in pixels.
    return res.status(400).json({ error: "That image could not be read. Try a different photo." });
  }

  const { publicPath, url } = await storage.saveImage(webp, "webp");
  if (url) return res.status(201).json({ url });

  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  res.status(201).json({ url: `${base}${publicPath}` });
}

module.exports = { uploadImage };
