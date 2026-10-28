const multer = require("multer");
const { MAX_DOCUMENT_BYTES } = require("../services/partnerDocuments.service");

// Memory storage so a rejected upload never touches disk; mounted after
// requireAuth so an unauthenticated request never gets its body parsed (same
// pattern as selfieUpload.middleware.js). The file's real type is checked from
// its bytes in the service — the client's Content-Type and name are ignored.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5 },
});

function parseDocument(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File is too large (max ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB)` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: "Send exactly one file in the 'file' field" });
    }
    return next(err);
  });
}

module.exports = { parseDocument };
