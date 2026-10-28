const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { parseDocument } = require("../middleware/documentUpload.middleware");
const partnerDocuments = require("../controllers/partnerDocuments.controller");

const router = express.Router();

// Partner web portal (partner.fengle.in): a restaurant or rider uploads their KYC /
// licence documents. allowUnverified because documents are part of getting
// verified — a partner whose selfie is still pending must be able to upload too.
const partner = requireAuth(["restaurant", "rider"], { allowUnverified: true });

router.get("/documents", partner, partnerDocuments.getMyDocuments);
router.post("/documents", partner, parseDocument, partnerDocuments.uploadMyDocument);
router.get("/documents/:id/file", partner, partnerDocuments.getMyDocumentFile);

module.exports = router;
