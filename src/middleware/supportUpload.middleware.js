const multer = require("multer");

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 3;

// Memory storage so a rejected upload never touches disk; mounted after requireAuth so an unauthenticated request never gets its body
// parsed (same pattern as documentUpload.middleware.js). The real type of each file is checked from its bytes in the service.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS, fields: 10 },
});

/** multipart/form-data with text fields plus up to 3 files in the "attachments" field (all optional). */
function parseSupportAttachments(req, res, next) {
  upload.array("attachments", MAX_ATTACHMENTS)(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `Each file can be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB` });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Attach at most ${MAX_ATTACHMENTS} files, in the 'attachments' field` });
    return next(err);
  });
}

module.exports = { parseSupportAttachments, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS };
