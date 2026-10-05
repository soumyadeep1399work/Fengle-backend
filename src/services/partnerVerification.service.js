const db = require("../config/db");
const { sendToOwner, notifyLater } = require("./push.service");

const PARTNERS = {
  restaurants: { ownerType: "restaurant", label: "kitchen" },
  riders: { ownerType: "rider", label: "rider" },
};

/**
 * Admin approve/deny of a partner's in-app agreement selfie.
 * `table` is "restaurants" or "riders". Returns { status, body } for the controller.
 *
 * - approve needs a selfie on file (there has to be something to approve).
 * - deny needs a reason; it re-opens the app's selfie step (agreementRequired
 *   is true while denied) and the partner's next upload goes back to 'pending'.
 * - Either decision may be made from any state, so an approval can be revoked.
 */
async function reviewPartner(table, id, adminId, decision, reason) {
  const partner = PARTNERS[table];
  if (!["approve", "deny"].includes(decision)) {
    return { status: 400, body: { error: "decision must be 'approve' or 'deny'" } };
  }
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (decision === "deny") {
    if (!trimmedReason) return { status: 400, body: { error: "A reason is required when denying" } };
    if (trimmedReason.length > 255) return { status: 400, body: { error: "reason must be at most 255 characters" } };
  }

  const row = await db(table).where({ id }).select("id", "agreement_selfie_path").first();
  if (!row) return { status: 404, body: { error: "Not found" } };
  if (decision === "approve" && !row.agreement_selfie_path) {
    return { status: 409, body: { error: "No selfie on file to approve — the partner hasn't submitted one yet" } };
  }

  const verificationStatus = decision === "approve" ? "approved" : "denied";
  const reviewedAt = new Date();
  await db(table).where({ id }).update({
    verification_status: verificationStatus,
    verification_denied_reason: decision === "deny" ? trimmedReason : null,
    verification_reviewed_at: reviewedAt,
    verification_reviewed_by_admin_id: adminId,
  });

  notifyLater(() =>
    sendToOwner(partner.ownerType, id, decision === "approve"
      ? { title: "You're approved", body: `Your ${partner.label} account is verified. You can start now.`, data: { type: "verification", status: "approved" } }
      : { title: "Photo not approved", body: `Please retake your verification photo. Reason: ${trimmedReason}`, data: { type: "verification", status: "denied" } })
  );

  return {
    status: 200,
    body: {
      verificationStatus,
      verificationDeniedReason: decision === "deny" ? trimmedReason : null,
      verificationReviewedAt: reviewedAt.toISOString(),
    },
  };
}

module.exports = { reviewPartner };
