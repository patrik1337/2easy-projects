// Rullen — daily movie-quiz game logic: question bank access, daily 5-question
// selection (no-repeat + Swedish bias), and server-authoritative timing.
const MOVIES = require('./_movies.json');
const { kv } = require('./_score');

// ===========================================================================
// EDIT ME: seconds allowed per question before it auto-locks as unanswered.
// ===========================================================================
const TIME_LIMIT_MS = 12000;
const GRACE_MS = 4000; // network-latency allowance on top of the limit

const byId = {};
MOVIES.forEach((m) => { byId[m.id] = m; });
const getQuestion = (id) => byId[id] || null;

const todayStockholm = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

// Public shape of a question — never includes the correct answer.
function publicQuestion(q, qIndex) {
  return { qIndex, qId: q.id, q: q.q, options: q.options, total: 5 };
}

// ── Daily 5-question selection (admin override → auto, cached per date) ────────
async function resolveTodayQuestions(date) {
  const [existing] = await kv([['GET', `quiz:today:${date}`]]);
  if (existing) { try { const ids = JSON.parse(existing); if (Array.isArray(ids) && ids.length === 5) return ids; } catch (_) {} }

  const [overrideRaw] = await kv([['GET', `quiz:override:${date}`]]);
  if (overrideRaw) {
    try {
      const ids = JSON.parse(overrideRaw).filter((id) => byId[id]).slice(0, 5);
      if (ids.length === 5) {
        const [claimed] = await kv([['SET', `quiz:today:${date}`, JSON.stringify(ids), 'NX']]);
        if (claimed === 'OK') await kv([['SADD', 'quiz:used', ...ids]]);
        else { const [again] = await kv([['GET', `quiz:today:${date}`]]); try { return JSON.parse(again); } catch (_) { return ids; } }
        return ids;
      }
    } catch (_) {}
  }

  const [usedRaw] = await kv([['SMEMBERS', 'quiz:used']]);
  const used = new Set(Array.isArray(usedRaw) ? usedRaw : []);

  // Exactly one Swedish-film question per day when possible — never more. The
  // other 4 slots are filled strictly from the international pool (no fallback
  // to extra Swedish ones), so a day can never end up with 2+. If international
  // supply for the current not-yet-used pool can't fill those 4, that's treated
  // as "not enough left" and triggers a full-bank cycle reset, same as running
  // out of questions entirely.
  function buildPicks(candidatePool) {
    const picks = [];
    const svenskPool = candidatePool.filter((q) => q.category === 'svensk');
    if (svenskPool.length) picks.push(svenskPool[Math.floor(Math.random() * svenskPool.length)]);
    const intlPool = shuffle(candidatePool.filter((q) => q.category !== 'svensk'));
    while (picks.length < 5 && intlPool.length) picks.push(intlPool.shift());
    return picks;
  }

  let pool = MOVIES.filter((q) => !used.has(q.id));
  let cycleReset = false;
  let picks = buildPicks(pool);
  if (picks.length < 5) { pool = MOVIES.slice(); cycleReset = true; picks = buildPicks(pool); }

  const ids = picks.map((q) => q.id);
  const [claimed] = await kv([['SET', `quiz:today:${date}`, JSON.stringify(ids), 'NX']]);
  if (claimed !== 'OK') { const [again] = await kv([['GET', `quiz:today:${date}`]]); try { return JSON.parse(again); } catch (_) { return ids; } }
  const cmds = [];
  if (cycleReset) cmds.push(['DEL', 'quiz:used']);
  if (ids.length) cmds.push(['SADD', 'quiz:used', ...ids]);
  await kv(cmds);
  return ids;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

module.exports = {
  MOVIES, TIME_LIMIT_MS, GRACE_MS, getQuestion, publicQuestion,
  todayStockholm, resolveTodayQuestions,
};
