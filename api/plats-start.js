const { kv, kvReady } = require('./_score');
const { todayStockholm, resolveTodayCity, getCity } = require('./_plats');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const { playerID, playerName } = req.body || {};
  if (!playerID) return res.status(400).json({ error: 'playerID required' });

  const date = todayStockholm();
  const city = getCity(await resolveTodayCity(date));
  if (!city) return res.status(500).json({ error: 'No city available' });

  // Already finished today → don't reveal/restart.
  const [done] = await kv([['GET', `plats:result:${date}:${playerID}`]]);
  if (done) return res.status(200).json({ already: true, played: true });

  // Stamp the start once; if they reload, keep the original timestamp (the clock keeps running).
  const now = Date.now();
  const [claimed] = await kv([['SET', `plats:start:${date}:${playerID}`, String(now), 'NX']]);
  let startTs = now;
  if (claimed !== 'OK') { const [ex] = await kv([['GET', `plats:start:${date}:${playerID}`]]); startTs = Number(ex) || now; }
  if (playerName) await kv([['HSET', 'score:names', playerID, String(playerName).slice(0, 24)]]);

  // City NAME revealed here (not before), coordinates never sent to the client.
  return res.status(200).json({ city: { name: city.name, country: city.country, region: city.region }, startTs });
};
