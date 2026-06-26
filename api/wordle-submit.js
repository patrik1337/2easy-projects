export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { playerID, playerName, attempts, won, date } = req.body || {};

  if (!playerID || !playerName || !date || typeof attempts !== 'number' || typeof won !== 'boolean') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  if (date !== today) return res.status(400).json({ error: 'Wrong date' });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_TOKEN;

  if (!url || !token) return res.status(500).json({ error: 'Storage not configured' });

  const doneKey = `wordle:done:${playerID}:${date}`;

  // Check for duplicate submission
  const checkRes = await fetch(`${url}/get/${encodeURIComponent(doneKey)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { result } = await checkRes.json();
  if (result !== null) return res.status(409).json({ error: 'Already submitted today' });

  // Score: 1-6 attempts (lower = better), 7 = loss
  const score = won ? attempts : 7;
  const leaderKey = `wordle:lb:${date}`;
  const safeName = playerName.slice(0, 20).replace(/["\\\n\r]/g, '');
  const member = JSON.stringify({ id: playerID, name: safeName, won, attempts });

  const pipeline = [
    ['SET', doneKey, '1', 'EX', String(60 * 60 * 48)],
    ['ZADD', leaderKey, String(score), member],
    ['EXPIRE', leaderKey, String(60 * 60 * 24 * 7)],
  ];

  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
  });

  return res.status(200).json({ ok: true });
}
