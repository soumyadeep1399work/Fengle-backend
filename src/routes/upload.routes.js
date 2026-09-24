const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth.middleware");
const uploads = require("../controllers/upload.controller");

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // the Restaurant app sends ~200 KB; 2 MB is generous headroom, not a target

const router = express.Router();

// Memory storage so a rejected upload never touches disk; multer aborts the
// stream as soon as it passes the size limit rather than buffering it all.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
});

// Auth runs first, so an unauthenticated request never gets its body parsed.
function parseImage(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `Image is too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: "Send exactly one file in the 'image' field" });
    }
    return next(err);
  });
}

router.post("/image", requireAuth(["restaurant", "admin"]), parseImage, uploads.uploadImage);

module.exports = router;
