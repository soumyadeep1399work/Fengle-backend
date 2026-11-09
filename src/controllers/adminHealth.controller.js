const systemHealth = require("../services/systemHealth.service");

/**
 * GET /admin/health (super_admin only; the route carries the guard). Read-only: a list of checks, see services/systemHealth.service.js.
 * ?refresh=1 re-runs the cheap checks now instead of reusing their short cache (billed and rate-limited checks ignore it).
 */
async function getHealth(req, res) {
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  res.set("Cache-Control", "no-store");
  res.json(await systemHealth.run({ refresh }));
}

module.exports = { getHealth };
