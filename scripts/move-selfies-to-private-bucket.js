// One-off (2026-10-28): moves agreement selfies that were saved to the PUBLIC bucket
// (AWS_S3_BUCKET, every key publicly readable) into the private bucket
// (AWS_S3_PRIVATE_BUCKET). The S3 key — and so agreement_selfie_path in the DB — stays
// the same; storage.readAgreementSelfie() looks in the private bucket first.
//
//   node scripts/move-selfies-to-private-bucket.js            copy + verify only (safe to re-run)
//   node scripts/move-selfies-to-private-bucket.js --delete   also delete each public copy, but only
//                                                             after its private copy is verified
//
// Run with NODE_ENV=production on the server (it uses the EC2 role, no keys).
require("dotenv").config();
const db = require("../src/config/db");
const { getS3Client, getS3Object } = require("../src/services/storage.service");

async function main() {
  const publicBucket = process.env.AWS_S3_BUCKET;
  const privateBucket = process.env.AWS_S3_PRIVATE_BUCKET;
  const doDelete = process.argv.includes("--delete");
  if (!publicBucket || !privateBucket) throw new Error("Both AWS_S3_BUCKET and AWS_S3_PRIVATE_BUCKET must be set");
  if (publicBucket === privateBucket) throw new Error("AWS_S3_PRIVATE_BUCKET must be a different bucket from AWS_S3_BUCKET");

  const { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = getS3Client();

  const rows = [];
  for (const table of ["restaurants", "riders"]) {
    const found = await db(table).where("agreement_selfie_path", "like", "agreement-selfies/%").select("id", "agreement_selfie_path");
    for (const r of found) rows.push({ table, id: r.id, key: r.agreement_selfie_path });
  }
  console.log(`${rows.length} selfie(s) stored in S3. Copying from ${publicBucket} to ${privateBucket}${doDelete ? ", then deleting public copies" : ""}.`);

  const counts = { copied: 0, alreadyPrivate: 0, deleted: 0, missing: 0, failed: 0 };
  for (const row of rows) {
    const label = `${row.table}#${row.id}`;
    try {
      let privateSize = null;
      try {
        privateSize = (await s3.send(new HeadObjectCommand({ Bucket: privateBucket, Key: row.key }))).ContentLength;
      } catch (err) {
        if (!["NotFound", "NoSuchKey", "AccessDenied", "Forbidden"].includes(err.name)) throw err;
      }

      let publicBody = null;
      try {
        publicBody = await getS3Object(publicBucket, row.key);
      } catch (err) {
        if (!["NoSuchKey", "AccessDenied", "NotFound"].includes(err.name)) throw err;
      }

      if (privateSize == null) {
        if (!publicBody) { counts.missing++; console.log(`  MISSING ${label}: not in either bucket`); continue; }
        const ext = row.key.split(".").pop();
        const contentType = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "application/octet-stream";
        await s3.send(new PutObjectCommand({ Bucket: privateBucket, Key: row.key, Body: publicBody, ContentType: contentType }));
        privateSize = (await s3.send(new HeadObjectCommand({ Bucket: privateBucket, Key: row.key }))).ContentLength;
        if (privateSize !== publicBody.length) throw new Error(`size mismatch after copy (${privateSize} vs ${publicBody.length})`);
        counts.copied++;
        console.log(`  copied  ${label} (${publicBody.length} bytes)`);
      } else {
        counts.alreadyPrivate++;
        console.log(`  ok      ${label} already in private bucket`);
      }

      if (doDelete && publicBody) {
        if (publicBody.length !== privateSize) throw new Error("private copy differs from public copy; not deleting");
        await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: row.key }));
        counts.deleted++;
        console.log(`  deleted ${label} public copy`);
      }
    } catch (err) {
      counts.failed++;
      console.log(`  FAILED  ${label}: ${err.name || ""} ${err.message}`);
    }
  }
  console.log("Done:", counts);
  await db.destroy();
  process.exit(counts.failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.destroy().catch(() => {});
  process.exit(1);
});
