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
 * Selfies go to AWS_S3_PRIVATE_BUCKET (Block Public Access on) when it's set —
 * the same private bucket as partner documents (2026-10-28). Only when it isn't
 * set do they fall back to AWS_S3_BUCKET, whose policy makes every key publicly
 * readable; scripts/move-selfies-to-private-bucket.js moves those older ones over.
 */
async function saveAgreementSelfie(buffer, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  const bucket = process.env.AWS_S3_PRIVATE_BUCKET || process.env.AWS_S3_BUCKET;

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
  const ext = path.extname(storedPath).slice(1);
  const contentType = CONTENT_TYPE[ext] || "application/octet-stream";

  // An S3 key has the "agreement-selfies/" prefix; the same key may live in the private
  // bucket (current) or, for selfies saved before it existed and not yet moved, the public one.
  if (storedPath.startsWith("agreement-selfies/")) {
    const buckets = [process.env.AWS_S3_PRIVATE_BUCKET, process.env.AWS_S3_BUCKET].filter(Boolean);
    let lastErr = new Error("No S3 bucket is configured for agreement selfies");
    for (const bucket of buckets) {
      try {
        const buffer = await getS3Object(bucket, storedPath);
        return { buffer, contentType };
      } catch (err) {
        // Without s3:ListBucket a missing key answers AccessDenied rather than NoSuchKey.
        if (!["NoSuchKey", "AccessDenied", "NotFound"].includes(err.name)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  const buffer = await fs.promises.readFile(path.join(AGREEMENT_SELFIE_DIR, storedPath));
  return { buffer, contentType };
}

// Partner KYC/licence documents (Aadhaar, FSSAI, trade/driving licence) are
// identity documents: they must NEVER land in AWS_S3_BUCKET, whose policy makes
// every key publicly readable. They go to AWS_S3_PRIVATE_BUCKET when that is set
// (a bucket with Block Public Access on, readable only by the EC2 instance role),
// otherwise to this directory, which — like agreement-selfies/ — is not mounted
// by express.static. Only the authenticated streaming endpoints read them back.
const PARTNER_DOCUMENT_DIR = path.join(__dirname, "../../partner-documents");
fs.mkdirSync(PARTNER_DOCUMENT_DIR, { recursive: true });

const DOCUMENT_CONTENT_TYPE = { ...CONTENT_TYPE, pdf: "application/pdf" };

/** Like detectImageType, plus PDF ("%PDF-" header). Returns the extension to store under, or null. */
function detectDocumentType(buf) {
  if (Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return detectImageType(buf);
}

/**
 * Saves an already-validated document. Returns { storagePath, contentType }:
 * storagePath is a private-bucket key ("partner-documents/<uuid>.<ext>") or a bare
 * file name on disk — never a URL, and never sent to any client.
 */
async function savePartnerDocument(buffer, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  const contentType = DOCUMENT_CONTENT_TYPE[ext] || "application/octet-stream";
  const bucket = process.env.AWS_S3_PRIVATE_BUCKET;

  if (bucket) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const key = `partner-documents/${name}`;
    await getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    return { storagePath: key, contentType };
  }

  await fs.promises.writeFile(path.join(PARTNER_DOCUMENT_DIR, name), buffer, { flag: "wx" });
  return { storagePath: name, contentType };
}

/**
 * Reads back a value savePartnerDocument() produced. storedPath always comes from
 * our own DB row, never from the request, so the plain path.join is safe. A key
 * with the "partner-documents/" prefix was written to the private bucket.
 */
async function readPartnerDocument(storedPath) {
  if (storedPath.startsWith("partner-documents/")) {
    const bucket = process.env.AWS_S3_PRIVATE_BUCKET;
    if (!bucket) throw new Error("AWS_S3_PRIVATE_BUCKET is not set but this document is stored in it");
    return getS3Object(bucket, storedPath);
  }
  return fs.promises.readFile(path.join(PARTNER_DOCUMENT_DIR, storedPath));
}

async function getS3Object(bucket, key) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const result = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = {
  UPLOAD_DIR, detectImageType, saveImage, saveAgreementSelfie, readAgreementSelfie, getS3Client, getS3Object,
  detectDocumentType, savePartnerDocument, readPartnerDocument,
};
