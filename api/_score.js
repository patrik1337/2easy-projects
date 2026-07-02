// Unified, game-agnostic cross-game scoreboard.
// Every game awards each player 0–5 points per day; those sum into ONE cumulative
// season total. Keyed by a stable playerID (never the display name) so scores survive
// a future move to admin-assigned accounts.
//
// Key scheme:
//   score:season                                ZSET   member=playerID, score=cumulative across ALL games+days
//                                                       (cross-game grand total — not shown on any individual
//                                                       game's own page; reserved for a future /spel front-page
//                                                       "total" view. Games display score:game:{game} instead —
//                                                       each game's own leaderboard is independent of the others.)
//   score:game:{game}                           ZSET   member=playerID, score=cumulative for just THIS game (all days)
//                                                       — this is what each game's own "Totalställning" reads.
//   score:names                                 HASH   playerID -> display name (shared across games using this
//                                                       system; kept in sync by the rename endpoint, api/rename.js)
//   score:contrib:{game}:{date}:{playerID}      STRING points (0–5) this game awarded this player this day (idempotency ledger)
//   score:daily:{game}:{date}                   ZSET   member=playerID, score=that day's points for that game (per-game daily board)
//   game = short slug ('ordel' | '1x2' | 'pricken' | 'rullen'); date = Stockholm 'YYYY-MM-DD'
//
// Migration notes for the other two games (do later; not touched here):
//   1x2:   in gradeMatch(), replace `ZINCRBY 1x2:season` with
//          awardPoints({game:'1x2', date: matchDate, playerID, name, points}) — it already yields 0–5.
//          Display via readGameSeason('1x2'). Backfill once by replaying old 1x2:season through awardPoints.
//   Ordel: map attempts->0–5 (e.g. 1–2=5,3=4,4=3,5=2,6=1,fail=0) and call
//          awardPoints({game:'ordel', date, playerID, name, points}) on completion. Keep wordle:lb:{date} for the word view.
//   Identity move: everything is keyed by playerID, so the season survives — remap members in
//          score:season/score:game:* and repoint score:names; no score loss.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.KV_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const kvReady = () => Boolean(KV_URL && KV_TOKEN);

async function kv(cmds) {
  if (!cmds.length) return [];
  if (!kvReady()) return cmds.map(() => null);
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const a = await r.json();
  return Array.isArray(a) ? a.map((x) => (x && 'result' in x ? x.result : null)) : cmds.map(() => null);
}

function hashToObj(h) {
  if (!h) return {};
  if (Array.isArray(h)) { const o = {}; for (let i = 0; i < h.length; i += 2) o[h[i]] = h[i + 1]; return o; }
  return h;
}

// Record (or correct) ONE game-day contribution. Idempotent: re-calling with the same
// points is a no-op; calling with different points applies only the delta (safe corrections,
// no double-counting) — works even if a lazy-grade fires on every page load.
async function awardPoints({ game, date, playerID, name, points }) {
  const pts = Math.max(0, Math.min(5, Number(points) || 0));
  const ledgerKey = `score:contrib:${game}:${date}:${playerID}`;
  const [prevRaw] = await kv([['GET', ledgerKey]]);
  const prev = prevRaw == null ? null : Number(prevRaw);
  if (prev === pts) {
    if (name) await kv([['HSET', 'score:names', playerID, String(name).slice(0, 24)]]);
    return { changed: false, points: pts };
  }
  const delta = pts - (prev || 0);
  const cmds = [
    ['SET', ledgerKey, String(pts)],
    ['ZINCRBY', 'score:season', String(delta), playerID],
    ['ZINCRBY', `score:game:${game}`, String(delta), playerID],
    ['ZADD', `score:daily:${game}:${date}`, String(pts), playerID],
  ];
  if (name) cmds.push(['HSET', 'score:names', playerID, String(name).slice(0, 24)]);
  await kv(cmds);
  return { changed: true, points: pts, delta };
}

async function getContribution(game, date, playerID) {
  if (!playerID) return null;
  const [v] = await kv([['GET', `score:contrib:${game}:${date}:${playerID}`]]);
  return v == null ? null : Number(v);
}

async function zTopWithNames(key, limit) {
  const [res] = await kv([['ZREVRANGE', key, '0', String(limit - 1), 'WITHSCORES']]);
  const rows = [];
  if (Array.isArray(res)) for (let i = 0; i < res.length; i += 2) rows.push({ id: res[i], pts: Number(res[i + 1]) });
  if (rows.length) {
    const [names] = await kv([['HMGET', 'score:names', ...rows.map((r) => r.id)]]);
    rows.forEach((r, i) => { r.name = (Array.isArray(names) && names[i]) || 'Anonym'; });
  }
  return rows;
}

// Cross-game grand total — not displayed on any individual game's page today;
// reserved for a future combined view on the /spel front page.
const readSeason = (limit = 50) => zTopWithNames('score:season', limit);
// A single game's own cumulative leaderboard (all days, that game only) — this is
// what each game's own "Totalställning" should read.
const readGameSeason = (game, limit = 50) => zTopWithNames(`score:game:${game}`, limit);
// A single game's per-day board (kept, not the shared one).
const readGameDay = (game, date, limit = 50) => zTopWithNames(`score:daily:${game}:${date}`, limit);

module.exports = { kv, kvReady, hashToObj, awardPoints, getContribution, readSeason, readGameSeason, readGameDay };
