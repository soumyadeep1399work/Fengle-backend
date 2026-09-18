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
  hashOtp,
  verifyOtpHash,
  getExpiryDate,
  OTP_TTL_MINUTES,
  MAX_ATTEMPTS,
};
