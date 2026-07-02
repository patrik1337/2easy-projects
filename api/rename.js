// Self-service nickname change. Keeps the SAME playerID (so all existing points
// stay attached) and just updates the display name everywhere it's looked up —
// score:names (shared by Pricken + Rullen) and 1x2:names (VM-Tips's own). Ordel's
// leaderboard embeds the name directly into each day's entry rather than looking
// it up from a shared hash, so past Ordel days keep whatever name was used that
// day; a rename only affects the games above, going forward.
const { kv, kvReady } = require('./_score');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const { playerID, newName } = req.body || {};
  const name = String(newName || '').trim().slice(0, 20);
  if (!playerID || !name) return res.status(400).json({ error: 'playerID and newName required' });

  await kv([
    ['HSET', 'score:names', playerID, name],
    ['HSET', '1x2:names', playerID, name],
  ]);

  return res.status(200).json({ ok: true, name });
};
