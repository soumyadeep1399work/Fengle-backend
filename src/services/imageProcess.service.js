// Every catalog photo is re-encoded as WebP on the server, whatever the client
// sent (JPEG/PNG/WebP from the apps, the Admin Panel, or a future iOS app): the
// photos are shown small in the customer app, so a full-size original is just
// wasted bandwidth. Re-encoding also drops EXIF metadata (GPS position, device
// model) — sharp keeps none unless asked.
//
// Tuned for a 1 GB t3.micro that already ran out of memory twice (see the AWS
// notes): one conversion at a time, sharp's cache off, and a pixel ceiling so a
// crafted "decompression bomb" is refused instead of allocating gigabytes.
const sharp = require("sharp");

sharp.cache(false);
sharp.concurrency(1);

const MAX_EDGE_PX = 1000; // longest side; the apps already send ~800 px
const WEBP_QUALITY = 78;
const MAX_INPUT_PIXELS = 40_000_000; // ~40 MP; a 12 MP phone photo is 30% of this

let queue = Promise.resolve();

/**
 * Converts a validated JPEG/PNG/WebP buffer to a resized WebP buffer.
 * Rejects if the bytes can't actually be decoded (truncated/corrupt file).
 * Jobs run strictly one after another.
 */
function toWebp(buffer) {
  const job = queue.then(() =>
    sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate() // apply the EXIF orientation before the metadata is dropped
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()
  );
  queue = job.catch(() => {}); // a failed job must not poison the queue
  return job;
}

module.exports = { toWebp };
