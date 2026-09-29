// Shared by restaurants and riders (one lever for both — see CLAUDE.md).
// Bumping this env var re-gates every account whose stored agreement_version
// is behind, without touching any row's data.
const CURRENT_AGREEMENT_VERSION = Number(process.env.CURRENT_AGREEMENT_VERSION) || 1;

function agreementRequired(row) {
  return row.agreement_accepted_at == null || row.agreement_version < CURRENT_AGREEMENT_VERSION;
}

module.exports = { CURRENT_AGREEMENT_VERSION, agreementRequired };
