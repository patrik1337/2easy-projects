const { resolveMatch, kvReady, kv, todayStockholm, validateBonusAnswers } = require('./_wc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  // Score-only: the 1X2 outcome is always derived from hs/as (see derivePick in
  // _wc.js), never submitted or stored separately — so a score and an outcome can
  // never disagree.
  const { playerID, playerName, matchId, hs, as, b } = req.body || {};
  const H = Number(hs), A = Number(as);
  if (!playerID || !playerName || !matchId ||
      !Number.isInteger(H) || !Number.isInteger(A) || H < 0 || A < 0 || H > 20 || A > 20) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Re-resolve server-side: must be today's match and not yet locked.
  const date = todayStockholm();
  const match = await resolveMatch(date);
  if (!match || match.matchId !== matchId) return res.status(400).json({ error: "Not today's match" });
  if (match.kickoffMs && Date.now() >= match.kickoffMs) return res.status(403).json({ error: 'Locked', locked: true });

  const safeName = String(playerName).slice(0, 20).replace(/["\\\n\r]/g, '');

  // All bonus questions must be answered — no partial bets that quietly forfeit
  // points (this is the exact mistake that slipped through before).
  const bv = validateBonusAnswers(match.bonus, b);
  if (!bv.ok) return res.status(400).json({ error: bv.error });
  const member = JSON.stringify({ hs: H, as: A, b: bv.b });

  // One submission per player per match (atomic).
  const [added] = await kv([['HSETNX', `1x2:pred:${matchId}`, playerID, member]]);
  await kv([['HSET', '1x2:names', playerID, safeName]]);

  if (added === 0 || added === '0') return res.status(409).json({ error: 'Already submitted', already: true });
  return res.status(200).json({ ok: true });
};
