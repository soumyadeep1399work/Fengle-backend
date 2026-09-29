const multer = require("multer");

const MAX_SELFIE_BYTES = 2 * 1024 * 1024; // matches POST /uploads/image's cap

// Memory storage so a rejected upload never touches disk. Mounted after
// requireAuth in each router, so an unauthenticated request never gets its
// body parsed — same pattern as upload.routes.js's parseImage.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SELFIE_BYTES, files: 1, fields: 5 },
});

function parseSelfie(req, res, next) {
  upload.single("selfie")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `Selfie is too large (max ${MAX_SELFIE_BYTES / (1024 * 1024)} MB)` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: "Send exactly one file in the 'selfie' field" });
    }
    return next(err);
  });
}

module.exports = { parseSelfie };
