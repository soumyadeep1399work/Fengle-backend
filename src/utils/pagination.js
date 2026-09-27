// Shared `?page=&limit=` contract for every Admin Panel list endpoint.
function paginationParams(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = { paginationParams };
