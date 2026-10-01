const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const routes = require("./routes");
const { UPLOAD_DIR } = require("./services/storage.service");

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  express.json({
    // The Razorpay webhook signature is computed over the exact bytes sent, so
    // that one route needs the unparsed body kept alongside the parsed one.
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith("/api/v1/payments/razorpay/webhook")) req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Uploaded images (dev: local disk; production would sit behind S3/CDN with the
// same URLs). helmet's default Cross-Origin-Resource-Policy is same-origin,
// which would stop the apps (Expo web on another port) rendering these in an
// <img>, so it's relaxed for this path only. Random file names, no directory
// listing, no dotfiles.
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    index: false,
    dotfiles: "deny",
    maxAge: "7d",
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/v1", routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler — every controller can just throw/reject and land here
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

module.exports = app;
