const rateLimit = require("express-rate-limit");

/**
 * Per-IP request limits, so one client (a script, a bug, an attacker) cannot hammer the API and starve everyone else on this
 * small server or run up SMS costs. In-memory counters: fine for the single PM2 process we run; they reset on a restart.
 *
 * The client IP only means something behind a reverse proxy when `trust proxy` is set (app.js does, for Apache's one hop);
 * without that, every request would look like it came from 127.0.0.1 and the whole customer base would share ONE bucket.
 *
 * The limits are deliberately generous for normal use: mobile carriers put many phones behind one IP (CGNAT), so a per-IP cap
 * has to tolerate a crowd. The strict, per-PHONE limits for OTPs live in auth.controller.js (they work on the number, not the IP).
 * Override with env vars (all counts are per IP per window); RATE_LIMIT_DISABLED=1 turns the lot off (tests, load tests).
 */
const WINDOW = 60 * 1000; // 1 minute
const num = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const disabled = () => process.env.RATE_LIMIT_DISABLED === "1";

function limiter({ windowMs = WINDOW, limit, message, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7", // RateLimit-* headers so a well-behaved client can back off
    legacyHeaders: false,
    message: { error: message },
    skip: (req) => disabled() || (skip ? skip(req) : false),
  });
}

// Everything: 1200 requests/min/IP. High on purpose: mobile carriers (Jio/Airtel CGNAT) put hundreds of phones behind one IP and the apps poll every few seconds. This only stops a flood.
// The Razorpay webhook is exempt: it comes from Razorpay's servers, must never be refused, and is signature-checked anyway.
const general = limiter({
  limit: () => num("RATE_LIMIT_GENERAL_PER_MIN", 1200),
  message: "Too many requests. Please slow down and try again in a minute.",
  skip: (req) => req.originalUrl.startsWith("/api/v1/payments/razorpay/webhook") || req.originalUrl === "/health",
});

// Asking for an OTP costs real SMS money, but the strict cap is per PHONE (auth.controller.js); this per-IP one only stops one address spraying many numbers: 60 per 10 minutes.
const otpRequest = limiter({
  windowMs: 10 * WINDOW,
  limit: () => num("RATE_LIMIT_OTP_REQUEST_PER_10MIN", 60),
  message: "Too many OTP requests from this network. Please wait a few minutes and try again.",
});

// Guessing OTPs: the per-code attempt cap already stops guessing one code, this stops spraying many phones from one IP.
const otpVerify = limiter({
  windowMs: 10 * WINDOW,
  limit: () => num("RATE_LIMIT_OTP_VERIFY_PER_10MIN", 120),
  message: "Too many attempts. Please wait a few minutes and try again.",
});

// Admin password guessing: strict, a person types a password a handful of times at most.
const adminLogin = limiter({
  windowMs: 15 * WINDOW,
  limit: () => num("RATE_LIMIT_ADMIN_LOGIN_PER_15MIN", 10),
  message: "Too many sign-in attempts. Please wait 15 minutes and try again.",
});

module.exports = { general, otpRequest, otpVerify, adminLogin };
