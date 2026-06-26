const { kv, kvReady, getResult, getData, gradeMatch, computePoints, zTop, attachNames } = require('./_wc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const matchId = req.query && req.query.matchId;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  if (!kvReady()) return res.status(200).json({ result: null, your: null, breakdown: null, daily: [], season: [] });

  try {
    // Result source: admin (authoritative) first; feed only if it ever flips finished=TRUE.
    let result = await getResult(matchId);
    if (!result) {
      const { matches } = await getData();
      const fm = matches.find((m) => `m${m.id}` === matchId);
      if (fm && String(fm.finished).toUpperCase() === 'TRUE') {
        result = { hs: Number(fm.home_score), as: Number(fm.away_score) };
      }
    }
    if (result) await gradeMatch(matchId, result.hs, result.as); // idempotent

    const playerID = req.query.playerID;
    let your = null;
    if (playerID) {
      const [pj] = await kv([['HGET', `1x2:pred:${matchId}`, playerID]]);
      if (pj) { try { your = JSON.parse(pj); } catch (_) {} }
    }
    const breakdown = your && result ? computePoints(your, result.hs, result.as) : null;

    const daily = await attachNames(await zTop(`1x2:daily:${matchId}`, 50));
    const season = await attachNames(await zTop('1x2:season', 50));
    return res.status(200).json({ result, your, breakdown, daily, season });
  } catch (e) {
    return res.status(500).json({ error: 'leaderboard failed', detail: String((e && e.message) || e) });
  }
};
