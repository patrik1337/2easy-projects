const { kv, kvReady, awardPoints } = require('./_score');
const { todayStockholm, resolveTodayCity, getCity, haversineKm, pointsForDistance } = require('./_plats');

const WINDOW_MS = 15000 + 4000; // 15s play window + grace for network latency

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const { playerID, playerName, lat, lng } = req.body || {};
  if (!playerID) return res.status(400).json({ error: 'playerID required' });

  const date = todayStockholm();
  const city = getCity(await resolveTodayCity(date));
  if (!city) return res.status(500).json({ error: 'No city available' });

  // One guess per day — return the stored result instead of re-scoring (idempotent).
  const [existing] = await kv([['GET', `plats:result:${date}:${playerID}`]]);
  if (existing) { try { return res.status(200).json(JSON.parse(existing)); } catch (_) {} }

  const [sRaw] = await kv([['GET', `plats:start:${date}:${playerID}`]]);
  if (!sRaw) return res.status(400).json({ error: 'not started' });
  const elapsed = Date.now() - Number(sRaw);

  const hasPin = typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

  let dist = null, pts = 0;
  if (hasPin && elapsed <= WINDOW_MS) {
    dist = haversineKm(lat, lng, city.lat, city.lng);
    pts = pointsForDistance(dist);
  }

  await awardPoints({ game: 'pricken', date, playerID, name: playerName, points: pts });

  const result = {
    played: true,
    guessLat: hasPin ? lat : null,
    guessLng: hasPin ? lng : null,
    trueLat: city.lat,
    trueLng: city.lng,
    distanceKm: dist != null ? Math.round(dist) : null,
    points: pts,
    city: city.name,
    country: city.country,
    late: elapsed > WINDOW_MS,
  };
  await kv([['SET', `plats:result:${date}:${playerID}`, JSON.stringify(result)]]);
  return res.status(200).json(result);
};
