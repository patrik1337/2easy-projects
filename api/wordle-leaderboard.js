export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.KV_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Storage not configured' });

  const leaderKey = `wordle:lb:${date}`;

  // ZRANGE with scores, ascending (lowest score = best)
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['ZRANGE', leaderKey, '0', '49', 'WITHSCORES'],
    ]),
  });

  const [{ result }] = await r.json();

  if (!Array.isArray(result) || result.length === 0) {
    return res.status(200).json({ scores: [] });
  }

  // result is [member, score, member, score, ...]
  const scores = [];
  for (let i = 0; i < result.length; i += 2) {
    try {
      const entry = JSON.parse(result[i]);
      scores.push({ ...entry, score: parseInt(result[i + 1], 10) });
    } catch {}
  }

  return res.status(200).json({ scores });
}
