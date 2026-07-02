const { kv, kvReady } = require('./_score');
const { todayStockholm, resolveTodayQuestions, getQuestion, publicQuestion, TIME_LIMIT_MS } = require('./_quiz');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const { playerID, playerName } = req.body || {};
  if (!playerID) return res.status(400).json({ error: 'playerID required' });

  const date = todayStockholm();
  const ids = await resolveTodayQuestions(date);
  if (!ids || ids.length !== 5) return res.status(500).json({ error: 'No quiz available' });

  const [done] = await kv([['GET', `quiz:result:${date}:${playerID}`]]);
  if (done) return res.status(200).json({ already: true, played: true });

  // Resume mid-quiz (e.g. page reload) at the same question, with a fresh timer —
  // a reload doesn't skip or extend the anti-google window in any useful way.
  const [existingIdx] = await kv([['GET', `quiz:qidx:${date}:${playerID}`]]);
  const qIndex = existingIdx != null ? Number(existingIdx) : 0;

  const qId = ids[qIndex];
  const q = getQuestion(qId);
  if (!q) return res.status(500).json({ error: 'Question missing' });

  const now = Date.now();
  const cmds = [
    ['SET', `quiz:qidx:${date}:${playerID}`, String(qIndex)],
    ['SET', `quiz:qshown:${date}:${playerID}`, String(now)],
  ];
  if (existingIdx == null) cmds.push(['SETNX', `quiz:start:${date}:${playerID}`, String(now)]);
  if (playerName) cmds.push(['HSET', 'score:names', playerID, String(playerName).slice(0, 24)]);
  await kv(cmds);

  return res.status(200).json({ ...publicQuestion(q, qIndex), qShownAt: now, timeLimitMs: TIME_LIMIT_MS });
};
