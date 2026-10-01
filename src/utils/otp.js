const crypto = require("crypto");
const bcrypt = require("bcrypt");

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;

function generateOtp() {
  // Numeric OTP, e.g. "482913"
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH - 1;
  return crypto.randomInt(min, max).toString();
}

/**
 * Demo logins (Play Store review, client demos, pilot accounts): a phone listed
 * in DEMO_LOGIN_PHONES always gets DEMO_LOGIN_OTP as its code and no SMS is
 * sent for it. Off unless both are set, and DEMO_LOGIN_OTP must be exactly
 * OTP_LENGTH digits. Anyone who knows a listed phone and the code can log in
 * as it, so list only numbers that exist for this purpose.
 */
function demoOtpFor(phone) {
  const otp = process.env.DEMO_LOGIN_OTP || "";
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(otp)) return null;
  const phones = (process.env.DEMO_LOGIN_PHONES || "").split(",").map((p) => p.trim());
  return phones.includes(phone) ? otp : null;
}

async function hashOtp(otp) {
  return bcrypt.hash(otp, 10);
}

async function verifyOtpHash(otp, hash) {
  return bcrypt.compare(otp, hash);
}

function getExpiryDate() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

module.exports = {
  generateOtp,
  demoOtpFor,
  hashOtp,
  verifyOtpHash,
  getExpiryDate,
  OTP_TTL_MINUTES,
  MAX_ATTEMPTS,
};
