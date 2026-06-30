// Pricken — daily city-location game logic: pool, distance, scoring bands, rotation.
const CITIES = require('./_cities.json');
const { kv } = require('./_score');

// ===========================================================================
// EDIT ME: distance (km) -> points. Max 5. Tune freely after playtesting.
// ===========================================================================
const SCORE_BANDS = [
  { maxKm: 100, pts: 5 },
  { maxKm: 300, pts: 4 },
  { maxKm: 750, pts: 3 },
  { maxKm: 2000, pts: 2 },
  { maxKm: 5000, pts: 1 },
  { maxKm: Infinity, pts: 0 },
];
function pointsForDistance(km) {
  for (const b of SCORE_BANDS) if (km <= b.maxKm) return b.pts;
  return 0;
}

// Great-circle distance in km (Haversine) — no external API.
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const cityById = {};
CITIES.forEach((c) => { cityById[c.id] = c; });
const getCity = (id) => cityById[id] || null;

// ── Dates (Stockholm) ───────────────────────────────────────────────────────
const todayStockholm = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
function prevDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// ── Rotation: never the same region two days running; no repeat until the pool cycles ──
function pickCity(lastRegion, used) {
  let candidates = CITIES.filter((c) => !used.has(c.id));
  let cycleReset = false;
  if (candidates.length === 0) { candidates = CITIES.slice(); cycleReset = true; } // pool exhausted -> recycle
  let pool = candidates.filter((c) => c.region !== lastRegion);
  if (pool.length === 0) pool = CITIES.filter((c) => c.region !== lastRegion); // relax "unused", keep region rule
  if (pool.length === 0) pool = candidates;                                    // final fallback
  return { cityId: pool[Math.floor(Math.random() * pool.length)].id, cycleReset };
}

// Resolve (and persist) the city for a given Stockholm date. Fully automatic; the
// date key flips at Stockholm midnight, so a new city appears each day with no input.
async function resolveTodayCity(date) {
  const [existing] = await kv([['GET', `plats:today:${date}`]]);
  if (existing && cityById[existing]) return existing;

  // Determine yesterday's region to avoid repeating it.
  let lastRegion = null;
  const [yCity] = await kv([['GET', `plats:today:${prevDateStr(date)}`]]);
  if (yCity && cityById[yCity]) lastRegion = cityById[yCity].region;
  if (!lastRegion) { const [lr] = await kv([['GET', 'plats:lastRegion']]); lastRegion = lr || null; }

  const [usedRaw] = await kv([['SMEMBERS', 'plats:used']]);
  const used = new Set(Array.isArray(usedRaw) ? usedRaw : []);

  const { cityId, cycleReset } = pickCity(lastRegion, used);

  // Claim the day's pick atomically; if another request won the race, use theirs.
  const [claimed] = await kv([['SET', `plats:today:${date}`, cityId, 'NX']]);
  if (claimed !== 'OK') {
    const [again] = await kv([['GET', `plats:today:${date}`]]);
    return again || cityId;
  }
  const cmds = [];
  if (cycleReset) cmds.push(['DEL', 'plats:used']);
  cmds.push(['SADD', 'plats:used', cityId]);
  cmds.push(['SET', 'plats:lastRegion', cityById[cityId].region]);
  await kv(cmds);
  return cityId;
}

module.exports = {
  CITIES, SCORE_BANDS, pointsForDistance, haversineKm, getCity,
  todayStockholm, prevDateStr, resolveTodayCity,
};
