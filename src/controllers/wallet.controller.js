const wallet = require("../services/wallet.service");

async function getMyWallet(req, res) {
  const { id, type } = req.auth;
  if (!["customer", "rider"].includes(type)) {
    return res.status(403).json({ error: "Only customers and riders have wallets" });
  }

  const balance = await wallet.getBalance(type, id);
  const history = await wallet.getHistory(type, id, { limit: Number(req.query.limit) || 50 });

  res.json({ balance, history });
}

/** GET /wallet/balance — same data as GET /wallet/me, split out per the Customer App's API contract. */
async function getMyBalance(req, res) {
  const { id, type } = req.auth;
  if (!["customer", "rider"].includes(type)) {
    return res.status(403).json({ error: "Only customers and riders have wallets" });
  }
  const balance = await wallet.getBalance(type, id);
  res.json({ balance });
}

/** GET /wallet/ledger — same data as GET /wallet/me's history, split out per the Customer App's API contract. */
async function getMyLedger(req, res) {
  const { id, type } = req.auth;
  if (!["customer", "rider"].includes(type)) {
    return res.status(403).json({ error: "Only customers and riders have wallets" });
  }
  const history = await wallet.getHistory(type, id, { limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 });
  res.json({ ledger: history });
}

module.exports = { getMyWallet, getMyBalance, getMyLedger };
