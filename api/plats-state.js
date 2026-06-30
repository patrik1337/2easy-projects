const { kv, readSeason } = require('./_score');
const { todayStockholm, resolveTodayCity } = require('./_plats');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const date = todayStockholm();
    await resolveTodayCity(date); // pre-pick the day's city (cron / first visitor); never leaks it

    const playerID = req.query && req.query.playerID;
    let result = null, hasStarted = false, startTs = null;
    if (playerID) {
      const [r, s] = await kv([
        ['GET', `plats:result:${date}:${playerID}`],
        ['GET', `plats:start:${date}:${playerID}`],
      ]);
      if (r) { try { result = JSON.parse(r); } catch (_) {} }
      if (s) { hasStarted = true; startTs = Number(s); }
    }

    const season = await readSeason(50);
    // Note: the city name is deliberately NOT returned unless the player has finished.
    return res.status(200).json({ date, played: Boolean(result), result, hasStarted, startTs, season });
  } catch (e) {
    return res.status(500).json({ error: 'state failed', detail: String((e && e.message) || e) });
  }
};
