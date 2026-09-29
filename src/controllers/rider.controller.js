const db = require("../config/db");
const { RIDER_RATE_PER_KM, MIN_EARNING_PER_DELIVERY } = require("../services/settlement.service");
const { CURRENT_AGREEMENT_VERSION, agreementRequired } = require("../utils/agreement");
const storage = require("../services/storage.service");

const VEHICLE_TYPES = ["bike", "scooter", "bicycle", "car"];

/**
 * GET /riders/me/rate — the live settlement rate, so a client-side earnings
 * estimate (there's no per-delivery earnings endpoint yet) never silently
 * drifts from what settleRider() actually pays once these placeholders are
 * confirmed with the client and the env vars change.
 */
async function getMyRate(req, res) {
  res.json({ rate_per_km: RIDER_RATE_PER_KM, min_earning_per_delivery: MIN_EARNING_PER_DELIVERY });
}

/**
 * GET /riders/me — profile + status + wallet balance in one shot, mirroring
 * GET /restaurants/me. The onboarding flow collects name/vehicle in a step
 * AFTER the OTP verify that creates the account (which only ever gets a
 * name, and only if passed on that first verify) — this is what the app
 * reads back to know whether that step still needs doing (name === null).
 */
async function getMyProfile(req, res) {
  const rider = await db("riders").where({ id: req.auth.id }).first();
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  res.json({
    rider: {
      id: rider.id,
      name: rider.name,
      phone: rider.phone,
      vehicle_type: rider.vehicle_type,
      vehicle_number: rider.vehicle_number,
      status: rider.status,
      wallet_balance: Number(rider.wallet_balance),
      agreementRequired: agreementRequired(rider),
    },
  });
}

/**
 * POST /riders/me/accept-agreement — same contract as the restaurant
 * counterpart (POST /restaurants/me/accept-agreement): multipart field
 * `selfie` + `agreement_version` (409 on mismatch), server clock only.
 */
async function acceptRiderAgreement(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "A selfie file is required (multipart/form-data, field name 'selfie')" });
  }
  const version = Number(req.body.agreement_version);
  if (!Number.isInteger(version)) {
    return res.status(400).json({ error: "agreement_version is required and must be an integer" });
  }
  if (version !== CURRENT_AGREEMENT_VERSION) {
    return res.status(409).json({ error: `agreement_version mismatch — current version is ${CURRENT_AGREEMENT_VERSION}` });
  }

  const ext = storage.detectImageType(req.file.buffer);
  if (!ext) {
    return res.status(400).json({ error: "Only JPEG, PNG or WebP images are accepted" });
  }

  const selfiePath = await storage.saveAgreementSelfie(req.file.buffer, ext);
  const acceptedAt = new Date();
  await db("riders").where({ id: req.auth.id }).update({
    agreement_accepted_at: acceptedAt,
    agreement_version: version,
    agreement_selfie_path: selfiePath,
  });

  res.json({ agreementAcceptedAt: acceptedAt.toISOString() });
}

/**
 * PATCH /riders/me
 * body: any of { name, vehicle_type, vehicle_number }
 * Fills in what the self-serve OTP signup never collects — the onboarding
 * step right after first verify. Phone isn't editable (it's the login
 * identity, same rule as PATCH /profile/me for customers).
 */
async function updateMyProfile(req, res) {
  const { name, vehicle_type, vehicle_number } = req.body || {};
  const updates = {};

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: "name must be a non-empty string of at most 120 characters" });
    }
    updates.name = name.trim();
  }
  if (vehicle_type !== undefined) {
    if (vehicle_type !== null && !VEHICLE_TYPES.includes(vehicle_type)) {
      return res.status(400).json({ error: `vehicle_type must be one of: ${VEHICLE_TYPES.join(", ")}` });
    }
    updates.vehicle_type = vehicle_type;
  }
  if (vehicle_number !== undefined) {
    if (vehicle_number !== null && (typeof vehicle_number !== "string" || vehicle_number.trim().length > 30)) {
      return res.status(400).json({ error: "vehicle_number must be a string of at most 30 characters" });
    }
    updates.vehicle_number = vehicle_number === null ? null : vehicle_number.trim();
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Send at least one of: name, vehicle_type, vehicle_number" });
  }

  await db("riders").where({ id: req.auth.id }).update(updates);
  return getMyProfile(req, res);
}

/**
 * PATCH /riders/me/availability
 * body: { status: 'active' | 'inactive' }
 * The online/offline toggle from the Rider Portal design.
 */
async function setAvailability(req, res) {
  const { status } = req.body;
  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
  }
  await db("riders").where({ id: req.auth.id }).update({ status });
  res.json({ message: `Rider marked ${status}` });
}

/**
 * PATCH /riders/me/location
 * body: { lat, lng }
 * Foreground-only location ping (see CLAUDE.md — no continuous background
 * GPS tracking in Phase 1). Called while the rider has an active delivery
 * open, purely to keep last_known_lat/lng fresh for the next auto-assignment.
 */
async function updateLocation(req, res) {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) {
    return res.status(400).json({ error: "lat and lng are required" });
  }
  await db("riders").where({ id: req.auth.id }).update({ last_known_lat: lat, last_known_lng: lng });
  res.json({ message: "Location updated" });
}

/**
 * GET /riders/me/orders — currently assigned active deliveries. Bare order
 * rows (no items) — for the pickup/dropoff screens the shared GET /orders/:id
 * has both items and the pickup-kitchen contact below; this is a lighter list.
 */
async function getMyAssignedOrders(req, res) {
  const orders = await db("orders")
    .join("restaurants", "restaurants.id", "orders.restaurant_id")
    .where("orders.rider_id", req.auth.id)
    .whereIn("orders.status", ["accepted", "picked_up", "on_the_way"])
    .orderBy("orders.created_at", "desc")
    .select(
      "orders.*",
      "restaurants.name as restaurant_name", "restaurants.address as restaurant_address",
      "restaurants.lat as restaurant_lat", "restaurants.lng as restaurant_lng"
    );
  res.json({ orders });
}

module.exports = { getMyProfile, updateMyProfile, getMyRate, setAvailability, updateLocation, getMyAssignedOrders, acceptRiderAgreement };
