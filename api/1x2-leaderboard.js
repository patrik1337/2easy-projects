const { kv, kvReady, getResult, getData, gradeMatch, computePoints, zTop, attachNames, getPredictions, toughestMatches } = require('./_wc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.query && req.query.toughest === '1') {
    if (!kvReady()) return res.status(200).json({ toughest: [] });
    try { return res.status(200).json({ toughest: await toughestMatches(20) }); }
    catch (e) { return res.status(500).json({ error: 'toughest failed', detail: String((e && e.message) || e) }); }
  }

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
    if (result) await gradeMatch(matchId, result); // idempotent

    const playerID = req.query.playerID;
    const allPreds = await getPredictions(matchId);
    const your = (playerID && allPreds.find((p) => p.id === playerID)) || null;
    const breakdown = your && result ? computePoints(your, result) : null;

    // Friends' picks are visible to everyone, even before you've tipped yourself.
    const predictions = allPreds.map((p) => {
      const o = { id: p.id, name: p.name, p: p.p, hs: p.hs, as: p.as, b: p.b };
      if (result) o.pts = computePoints(p, result).pts;
      return o;
    });
    if (result) predictions.sort((a, b) => b.pts - a.pts);
    else predictions.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const revealed = true;

    const season = await attachNames(await zTop('1x2:season', 50));
    return res.status(200).json({ result, your, breakdown, predictions, revealed, season });
  } catch (e) {
    return res.status(500).json({ error: 'leaderboard failed', detail: String((e && e.message) || e) });
  }
};
