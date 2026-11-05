const express = require("express");
// Express 4 ignores a rejected promise from an async handler, so one bad request that makes a controller
// throw would crash the whole Node process. This patch forwards it to the error handler below instead.
// Must load right after express and before any route is created.
require("express-async-errors");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const routes = require("./routes");
const rateLimitMiddleware = require("./middleware/rateLimit.middleware");
const { UPLOAD_DIR } = require("./services/storage.service");

const app = express();

// Apache sits in front of Node on this server (one hop). Trusting exactly that hop makes req.ip the real client address from
// X-Forwarded-For (needed by the rate limiter); trusting more would let a client spoof its IP with its own header.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors());
app.use(rateLimitMiddleware.general);
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

/**
 * Central error handler — every controller can just throw/reject and land here.
 * Deliberate errors (an `err.status` below 500: validation, BankError, bad JSON) keep their message. Anything else is an unexpected
 * server fault — a database error, a bug — and in production its text is NEVER sent to the client: it would hand table names, column
 * names and constraint names (and sometimes the failing query's values) to whoever triggers it, and the apps print it on screen. The
 * client gets a generic message plus a short `ref`; the full error is logged server-side under the same ref.
 */
function errorHandler(err, req, res, next) {
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
  if (status < 500) {
    console.error(err);
    return res.status(status).json({ error: err.message || "Request failed" });
  }
  const ref = require("crypto").randomBytes(4).toString("hex");
  console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
  if (process.env.NODE_ENV === "production") {
    return res.status(status).json({ error: "Something went wrong on our side. Please try again in a moment.", ref });
  }
  return res.status(status).json({ error: err.message || "Internal server error", ref }); // detail only outside production
}
app.use(errorHandler);
app.errorHandler = errorHandler;

module.exports = app;
