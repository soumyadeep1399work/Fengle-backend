// Image storage behind one small contract so production can move to S3
// (CLAUDE.md tech stack) — set AWS_S3_BUCKET and saveImage() switches to S3
// automatically; leave it unset (dev/no AWS available) and it falls back to
// local disk exactly as before. Callers depend on nothing but the returned
// { name, publicPath, url } shape.
//
// Dev fallback (no AWS_S3_BUCKET): files go to fengle-backend/uploads/ and
// are served by app.js at /uploads. File names are always random UUIDs; the
// client's file name is never used (no path tricks, no collisions, nothing
// to guess).
//
// S3 mode: uploaded via the AWS SDK's default credential provider chain —
// on the EC2 instance this resolves through the instance's IAM role, no
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY needed (and none should be put in
// .env in production). The bucket must have public GetObject via its bucket
// policy (see the S3 setup notes) — objects are uploaded with no ACL, since
// an ACLs-disabled bucket rejects per-object ACLs.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Agreement selfies are never public (a person's face, not a catalog photo)
// — this directory is NOT mounted by app.js's express.static, unlike
// UPLOAD_DIR. Only the admin streaming endpoint (adminOrders-adjacent
// controllers) reads from here, and only after requireAuth(['admin']).
const AGREEMENT_SELFIE_DIR = path.join(__dirname, "../../agreement-selfies");
fs.mkdirSync(AGREEMENT_SELFIE_DIR, { recursive: true });

const CONTENT_TYPE = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

let s3Client = null;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({ region: process.env.AWS_REGION || "ap-south-1" });
  }
  return s3Client;
}

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

/**
 * Saves an already-validated image buffer.
 * S3 mode resolves { name, url } (url is the final absolute S3 object URL).
 * Disk mode resolves { name, publicPath } (caller builds the absolute URL —
 * disk-served files need the request's own host, which this module doesn't have).
 */
async function saveImage(buffer, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  const bucket = process.env.AWS_S3_BUCKET;

  if (bucket) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: name,
        Body: buffer,
        ContentType: CONTENT_TYPE[ext] || "application/octet-stream",
      })
    );
    const region = process.env.AWS_REGION || "ap-south-1";
    return { name, url: `https://${bucket}.s3.${region}.amazonaws.com/${name}` };
  }

  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buffer, { flag: "wx" });
  return { name, publicPath: `/uploads/${name}` };
}

/**
 * Saves an agreement selfie outside the public upload path. Returns the
 * value to store verbatim in agreement_selfie_path — a bare filename on disk,
 * an S3 key (prefixed "agreement-selfies/") in S3 mode. Never a URL: nothing
 * downstream should be able to construct a public link from this value.
 *
 * NOTE: in S3 mode this bucket's policy grants public s3:GetObject on every
 * key (see AWS deployment notes) — namespacing under a prefix keeps it out
 * of the public catalog-image listing/UI, but an attacker who somehow
 * learned the random key could still fetch it directly from S3. Revisit
 * (e.g. a second, non-public bucket) if this needs to be airtight.
 */
async function saveAgreementSelfie(buffer, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  const bucket = process.env.AWS_S3_BUCKET;

  if (bucket) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const key = `agreement-selfies/${name}`;
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: CONTENT_TYPE[ext] || "application/octet-stream",
      })
    );
    return key;
  }

  await fs.promises.writeFile(path.join(AGREEMENT_SELFIE_DIR, name), buffer, { flag: "wx" });
  return name;
}

/**
 * Reads back a value saveAgreementSelfie() produced, for the admin streaming
 * endpoint. storedPath always originates from our own DB column (never taken
 * from a request path param at read time), so there's no path-traversal
 * surface here despite the plain path.join.
 */
async function readAgreementSelfie(storedPath) {
  const bucket = process.env.AWS_S3_BUCKET;
  const ext = path.extname(storedPath).slice(1);
  const contentType = CONTENT_TYPE[ext] || "application/octet-stream";

  if (bucket) {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const result = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: storedPath }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: result.ContentType || contentType };
  }

  const buffer = await fs.promises.readFile(path.join(AGREEMENT_SELFIE_DIR, storedPath));
  return { buffer, contentType };
}

module.exports = { UPLOAD_DIR, detectImageType, saveImage, saveAgreementSelfie, readAgreementSelfie };
