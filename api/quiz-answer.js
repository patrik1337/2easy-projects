const { kv, kvReady, awardPoints, readSeason } = require('./_score');
const { todayStockholm, resolveTodayQuestions, getQuestion, publicQuestion, TIME_LIMIT_MS, GRACE_MS } = require('./_quiz');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const { playerID, playerName, qIndex, answer } = req.body || {};
  const idx = Number(qIndex);
  if (!playerID || !Number.isInteger(idx) || idx < 0 || idx > 4) return res.status(400).json({ error: 'Invalid payload' });

  const date = todayStockholm();
  const ids = await resolveTodayQuestions(date);
  if (!ids || ids.length !== 5) return res.status(500).json({ error: 'No quiz available' });

  // Already finished today — idempotent, return the stored result instead of re-grading.
  const [doneRaw] = await kv([['GET', `quiz:result:${date}:${playerID}`]]);
  if (doneRaw) { try { return res.status(200).json(JSON.parse(doneRaw)); } catch (_) {} }

  // Must match the question we actually dispatched — prevents replay/out-of-order calls.
  const [curIdxRaw] = await kv([['GET', `quiz:qidx:${date}:${playerID}`]]);
  if (curIdxRaw == null || Number(curIdxRaw) !== idx) return res.status(400).json({ error: 'Wrong question index' });

  const [shownRaw] = await kv([['GET', `quiz:qshown:${date}:${playerID}`]]);
  const elapsed = Date.now() - Number(shownRaw || 0);
  const q = getQuestion(ids[idx]);
  if (!q) return res.status(500).json({ error: 'Question missing' });

  // Server-authoritative: a late or missing answer never counts, regardless of
  // what the client sends — the clock lives here, not in the browser.
  const inTime = shownRaw != null && elapsed <= TIME_LIMIT_MS + GRACE_MS;
  const givenAnswer = inTime && typeof answer === 'string' ? answer : null;
  const correct = givenAnswer != null && givenAnswer === q.correct;

  const [answersRaw] = await kv([['GET', `quiz:answers:${date}:${playerID}`]]);
  let answers = [];
  try { answers = JSON.parse(answersRaw) || []; } catch (_) {}
  answers.push({ qId: q.id, q: q.q, options: q.options, yourAnswer: givenAnswer, correctAnswer: q.correct, correct });

  if (idx < 4) {
    const nextQ = getQuestion(ids[idx + 1]);
    const now = Date.now();
    await kv([
      ['SET', `quiz:answers:${date}:${playerID}`, JSON.stringify(answers)],
      ['SET', `quiz:qidx:${date}:${playerID}`, String(idx + 1)],
      ['SET', `quiz:qshown:${date}:${playerID}`, String(now)],
    ]);
    return res.status(200).json({ ...publicQuestion(nextQ, idx + 1), qShownAt: now, timeLimitMs: TIME_LIMIT_MS });
  }

  // Fifth answer — finalize, score, and write into the unified cross-game board.
  const score = answers.filter((a) => a.correct).length;
  const result = { done: true, played: true, score, breakdown: answers };
  await kv([['SET', `quiz:answers:${date}:${playerID}`, JSON.stringify(answers)]]);
  await awardPoints({ game: 'rullen', date, playerID, name: playerName, points: score });
  await kv([['SET', `quiz:result:${date}:${playerID}`, JSON.stringify(result)]]);
  const season = await readSeason(50);
  return res.status(200).json({ ...result, season });
};
