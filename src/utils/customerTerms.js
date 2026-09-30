// Separate from CURRENT_AGREEMENT_VERSION (src/utils/agreement.js), which
// gates the restaurant/rider partner agreement — a different document with a
// different owner and change cadence. Bumping the customer T&C shouldn't
// re-gate every restaurant/rider, and vice versa.
const CUSTOMER_TERMS_VERSION = Number(process.env.CUSTOMER_TERMS_VERSION) || 1;

function customerAgreementRequired(row) {
  return row.agreement_accepted_at == null || row.agreement_version < CUSTOMER_TERMS_VERSION;
}

module.exports = { CUSTOMER_TERMS_VERSION, customerAgreementRequired };
