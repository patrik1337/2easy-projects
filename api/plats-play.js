// Consolidated: GET = state check, POST {phase:'start'} = begin, POST
// {phase:'submit', lat, lng} = grade the day's guess. Merged from three
// separate files into one to stay under Vercel's per-deployment function cap
// (same pattern as api/quiz-play.js).
const { kv, kvReady, awardPoints, readGameSeason } = require('./_score');
const { todayStockholm, resolveTodayCity, getCity, haversineKm, pointsForDistance } = require('./_plats');

const WINDOW_MS = 15000 + 4000; // 15s play window + grace for network latency

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleState(req, res);
  if (req.method === 'POST') {
    const phase = (req.body && req.body.phase) || 'start';
    if (phase === 'submit') return handleSubmit(req, res);
    return handleStart(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
};

async function handleState(req, res) {
  res.setHeader('Cache-Control', 'no-store');
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

    const season = await readGameSeason('pricken', 50);
    // Note: the city name is deliberately NOT returned unless the player has finished.
    return res.status(200).json({ date, played: Boolean(result), result, hasStarted, startTs, season });
  } catch (e) {
    return res.status(500).json({ error: 'state failed', detail: String((e && e.message) || e) });
  }
}

async function handleStart(req, res) {
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
}

async function handleSubmit(req, res) {
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
}
