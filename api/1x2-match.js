const { resolveMatch, getData, nextMatch, getResult, todayStockholm } = require('./_wc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store'); // lock state & result are time-sensitive
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const date = (req.query && req.query.date) || todayStockholm();
    const match = await resolveMatch(date);

    if (!match) {
      const { matches, teamById } = await getData();
      return res.status(200).json({ match: null, next: nextMatch(matches, teamById, Date.now()) });
    }

    const locked = match.kickoffMs != null && Date.now() >= match.kickoffMs;
    const result = await getResult(match.matchId);
    return res.status(200).json({
      match: {
        matchId: match.matchId,
        dateSthlm: date,
        kickoffMs: match.kickoffMs,
        locked,
        home: match.home,
        away: match.away,
        group: match.group,
        stage: match.stage,
        bonus: match.bonus || [],
      },
      result,
    });
  } catch (e) {
    return res.status(500).json({ error: 'match resolve failed', detail: String((e && e.message) || e) });
  }
};
