const { kv, readSeason } = require('./_score');
const { todayStockholm, resolveTodayQuestions } = require('./_quiz');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const date = todayStockholm();
    await resolveTodayQuestions(date); // pre-pick today's 5; never leaks them here

    const playerID = req.query && req.query.playerID;
    let result = null, inProgress = false, qIndex = 0;
    if (playerID) {
      const [r, idx] = await kv([
        ['GET', `quiz:result:${date}:${playerID}`],
        ['GET', `quiz:qidx:${date}:${playerID}`],
      ]);
      if (r) { try { result = JSON.parse(r); } catch (_) {} }
      if (!result && idx != null) { inProgress = true; qIndex = Number(idx); }
    }

    const season = await readSeason(50);
    return res.status(200).json({ date, played: Boolean(result), result, inProgress, qIndex, season });
  } catch (e) {
    return res.status(500).json({ error: 'state failed', detail: String((e && e.message) || e) });
  }
};
