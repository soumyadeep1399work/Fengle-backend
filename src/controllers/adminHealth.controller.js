const systemHealth = require("../services/systemHealth.service");

/**
 * GET /admin/health (super_admin only; the route carries the guard). Read-only: a list of checks, see services/systemHealth.service.js.
 *   (no query)         cached results, never counted
 *   ?refresh=1         "Check now": re-run every check (2 per IST day, all admins together)
 *   ?key=<check key>   re-run one check (free: 20 s apart; paid: 2 per IST day per key)
 * Over a limit -> 429 { error, code: "refresh_limit", next_at }; unknown key -> 400 { error, code: "unknown_key" }.
 */
async function getHealth(req, res) {
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  const key = typeof req.query.key === "string" && req.query.key ? req.query.key : null;
  res.set("Cache-Control", "no-store");
  try {
    res.json(await systemHealth.run({ refresh, key }));
  } catch (err) {
    if (!err.health) throw err;
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.next_at ? { next_at: err.next_at } : {}) });
  }
}

module.exports = { getHealth };
