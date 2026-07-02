const { kv, kvReady } = require('./_score');
const { MOVIES, todayStockholm } = require('./_quiz');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const body = req.body || {};
  const action = body.action;

  try {
    // Full question bank (id/text/category/decade only) — powers the admin picker.
    if (action === 'listQuestions') {
      const questions = MOVIES.map((m) => ({ id: m.id, q: m.q, category: m.category, decade: m.decade }));
      return res.status(200).json({ questions });
    }

    // Pin a specific date's 5 questions (e.g. a themed movie night). Default is
    // fully automatic; this is optional and only affects the given date.
    if (action === 'setOverride') {
      const { date, ids } = body;
      const day = date || todayStockholm();
      if (!Array.isArray(ids) || ids.length !== 5) return res.status(400).json({ error: 'Exactly 5 question ids required' });
      const valid = ids.every((id) => MOVIES.some((m) => m.id === id));
      if (!valid) return res.status(400).json({ error: 'Unknown question id' });
      if (new Set(ids).size !== 5) return res.status(400).json({ error: 'Duplicate question ids' });
      await kv([
        ['SET', `quiz:override:${day}`, JSON.stringify(ids)],
        ['DEL', `quiz:today:${day}`], // clear any already-resolved auto-pick for this date
      ]);
      return res.status(200).json({ ok: true, date: day });
    }

    if (action === 'clearOverride') {
      const { date } = body;
      const day = date || todayStockholm();
      await kv([['DEL', `quiz:override:${day}`], ['DEL', `quiz:today:${day}`]]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'admin failed', detail: String((e && e.message) || e) });
  }
};
