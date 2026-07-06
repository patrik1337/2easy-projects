// Shared helpers for the VM-Tips (1x2) World Cup prediction game.
// Underscore-prefixed → Vercel does not expose this as a route, only as an import.

const RAW = 'https://raw.githubusercontent.com/rezarahiminia/worldcup2026/main';

// Venue UTC offsets for the tournament window (Jun 11 – Jul 19 2026). DST is stable
// across this window: US/Canada observe DST; Mexico abolished DST in 2022.
const STADIUM_OFFSET = {
  '1': -6, '2': -6, '3': -6,                               // Mexico (CST, no DST)
  '4': -5, '5': -5, '6': -5,                               // US Central (CDT)
  '7': -4, '8': -4, '9': -4, '10': -4, '11': -4, '12': -4, // US/Canada Eastern (EDT)
  '13': -7, '14': -7, '15': -7, '16': -7,                  // US/Canada Pacific (PDT)
};

// Rough strength ranking by FIFA code — lower = stronger. Used only to pick the
// "biggest matchup" when Sweden isn't playing. Approximate; admin can always override.
const RANK = {
  ESP: 1, ARG: 2, FRA: 3, ENG: 4, BRA: 5, POR: 6, NED: 7, BEL: 8, GER: 9, CRO: 10,
  URU: 11, COL: 12, MAR: 13, USA: 14, MEX: 15, SUI: 16, JPN: 17, SEN: 18, IRN: 19, KOR: 20,
  ECU: 21, AUT: 22, AUS: 23, CAN: 24, NOR: 25, EGY: 26, SWE: 27, TUR: 28, PAR: 29, CIV: 30,
  SCO: 31, CZE: 32, PAN: 33, NZL: 34, QAT: 35, KSA: 36, RSA: 37, UZB: 38, JOR: 39, IRQ: 40,
  ALG: 41, COD: 42, GHA: 43, TUN: 44, CPV: 45, CUW: 46, HAI: 47, BIH: 28,
};
const rankOf = (code) => RANK[code] ?? 99;

// Accept the common Upstash/Vercel-KV env var names so this works regardless of
// which integration created them (KV_REST_API_TOKEN is the Vercel default).
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.KV_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const kvReady = () => Boolean(KV_URL && KV_TOKEN);

// Upstash REST pipeline. Returns an array of results (one per command). When KV is
// not configured (e.g. local preview), degrades to nulls so read paths still render.
async function kv(cmds) {
  if (!cmds.length) return [];
  if (!kvReady()) return cmds.map(() => null);
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const arr = await r.json();
  return Array.isArray(arr) ? arr.map((x) => (x && 'result' in x ? x.result : null)) : cmds.map(() => null);
}

function hashToObj(h) {
  if (!h) return {};
  if (Array.isArray(h)) {
    const o = {};
    for (let i = 0; i < h.length; i += 2) o[h[i]] = h[i + 1];
    return o;
  }
  return h; // some REST modes already return an object
}

// ── Date / time ───────────────────────────────────────────────────────────────
function todayStockholm() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}
function stockholmDateStr(ms) {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}
// "MM/DD/YYYY HH:MM" → "YYYY-MM-DD" using the match's own venue-local calendar date.
// We bucket the daily match by venue-local date so "today's game" is one that actually
// plays during the Swedish day, instead of a US-evening game that lands at ~01:00 Stockholm.
function venueDateStr(localDate) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(localDate || '').trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}
// "MM/DD/YYYY HH:MM" venue-local → epoch ms (UTC), via the venue's fixed summer offset.
function kickoffMs(localDate, stadiumId) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(String(localDate || '').trim());
  if (!m) return null;
  const mo = +m[1], d = +m[2], y = +m[3], hh = +m[4], mm = +m[5];
  const off = STADIUM_OFFSET[String(stadiumId)] ?? -4;
  return Date.UTC(y, mo - 1, d, hh, mm) - off * 3600 * 1000;
}

// ── Feed data ───────────────────────────────────────────────────────────────
async function getData() {
  const [mr, tr] = await Promise.all([
    fetch(`${RAW}/football.matches.json`),
    fetch(`${RAW}/football.teams.json`),
  ]);
  const matches = await mr.json();
  const teams = await tr.json();
  const teamById = {};
  for (const t of teams) teamById[String(t.id)] = t;
  return { matches, teamById };
}

function teamView(t) {
  return t ? { name: t.name_en, flag: t.flag, code: t.fifa_code } : null;
}

// Normalize a raw feed match into the shape the app uses everywhere.
function normalizeFeedMatch(fm, teamById, dateStr) {
  const ko = kickoffMs(fm.local_date, fm.stadium_id);
  return {
    matchId: `m${fm.id}`,
    feedId: String(fm.id),
    dateStr: dateStr || venueDateStr(fm.local_date),
    kickoffMs: ko,
    home: teamView(teamById[String(fm.home_team_id)]),
    away: teamView(teamById[String(fm.away_team_id)]),
    group: fm.group || '',
    stage: fm.type || 'group',
    source: 'feed',
  };
}

const hasRealTeams = (fm, teamById) =>
  teamById[String(fm.home_team_id)] && teamById[String(fm.away_team_id)];

// Pick the day's match: Sweden first (team id 23), else best combined ranking.
function pickMatchOfDay(matches, teamById, dateStr) {
  const todays = matches
    .map((fm) => ({ fm, ko: kickoffMs(fm.local_date, fm.stadium_id) }))
    .filter((x) => venueDateStr(x.fm.local_date) === dateStr && hasRealTeams(x.fm, teamById));
  if (!todays.length) return null;
  const swe = todays.find((x) => x.fm.home_team_id === '23' || x.fm.away_team_id === '23');
  if (swe) return swe.fm;
  todays.sort((a, b) => {
    const ra = rankOf(teamById[a.fm.home_team_id].fifa_code) + rankOf(teamById[a.fm.away_team_id].fifa_code);
    const rb = rankOf(teamById[b.fm.home_team_id].fifa_code) + rankOf(teamById[b.fm.away_team_id].fifa_code);
    return ra - rb;
  });
  return todays[0].fm;
}

function nextMatch(matches, teamById, nowMs) {
  const fut = matches
    .map((fm) => ({ fm, ko: kickoffMs(fm.local_date, fm.stadium_id) }))
    .filter((x) => x.ko != null && x.ko > nowMs && hasRealTeams(x.fm, teamById))
    .sort((a, b) => a.ko - b.ko);
  return fut[0] ? normalizeFeedMatch(fut[0].fm, teamById, stockholmDateStr(fut[0].ko)) : null;
}

// ── Match resolution (override → feed) ────────────────────────────────────────
async function getOverride(dateStr) {
  const [v] = await kv([['GET', `1x2:override:${dateStr}`]]);
  if (!v) return null;
  try { return withBonus(JSON.parse(v)); } catch { return null; }
}

// The admin-pinned "current" match (used for knockouts the feed can't supply). It
// persists across days until the admin replaces it — so a playoff game stays the
// active match right up until it's played and graded.
async function getCurrent() {
  const [v] = await kv([['GET', '1x2:current']]);
  if (!v) return null;
  try { return withBonus(JSON.parse(v)); } catch { return null; }
}

// Every match — admin-pinned or feed-selected — always carries the 5 bonus questions
// (10 p total possible per match, every game, going forward). getOverride/getCurrent
// backfill it centrally (see withBonus) so this file is the single source of truth;
// the feed-auto-select path attaches it directly below for the same guarantee.
async function resolveMatch(dateStr) {
  const override = await getOverride(dateStr);   // explicit per-day pin (highest priority) — already carries .bonus
  if (override) return override;
  const current = await getCurrent();            // admin-set match, persists until replaced — already carries .bonus
  if (current) return current;
  const { matches, teamById } = await getData(); // feed auto-select (group stage)
  const fm = pickMatchOfDay(matches, teamById, dateStr);
  if (!fm) return null;
  return withBonus(normalizeFeedMatch(fm, teamById, dateStr));
}
// Always (re)generate .bonus fresh from the match's current team names. Bonus
// questions are never customized per-match, so there's no reason a stored match
// should ever carry a stale/outdated set — this also means wording fixes to
// buildBonus() apply immediately to already-pinned matches, not just new ones.
function withBonus(match) {
  match.bonus = buildBonus(match);
  return match;
}

// ── Results & grading ─────────────────────────────────────────────────────────
async function getResult(matchId) {
  const [v] = await kv([['GET', `1x2:result:${matchId}`]]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// Optional bonus questions attached to a match (admin-graded; e.g. knockout extras).
// Options that reference the teams are generated from the match so it stays generic.
function buildBonus(match) {
  const H = (match.home && match.home.name) || 'Hemma';
  const A = (match.away && match.away.name) || 'Borta';
  return [
    { id: 'yellows', q: 'Antal gula kort totalt', type: 'number' },
    { id: 'penalties', q: 'Blir det straff i matchen?', type: 'choice', options: ['Ja', 'Nej'] },
    { id: 'possession', q: 'Högst bollinnehav?', type: 'choice', options: [H, A] },
    { id: 'redcard', q: 'Blir det rött kort?', type: 'choice', options: ['Ja', 'Nej'] },
    { id: 'corners', q: 'Flest hörnor?', type: 'choice', options: [H, A, 'Lika'] },
  ];
}

// Validate a set of bonus answers against a match's bonus questions. Every
// question must be answered when requireAll is true (the default, used for player
// bets) — no partial bets that quietly forfeit bonus points. The admin's
// result-facit entry passes requireAll=false since it may be filled in before
// every stat is known. Shared by the player-submit endpoint, the admin
// fix-a-prediction tool, and the admin result-facit entry so the same rule
// applies everywhere a bonus answer set is written.
function validateBonusAnswers(bonusDefs, incoming, requireAll = true) {
  const b = {};
  for (const d of bonusDefs || []) {
    const v = incoming ? incoming[d.id] : undefined;
    if (v == null || v === '') {
      if (requireAll) return { ok: false, error: `Alla extrafrågor måste besvaras (saknas: ${d.q})` };
      continue;
    }
    if (d.type === 'choice' && !(d.options || []).includes(String(v))) return { ok: false, error: `Ogiltigt svar: ${d.q}` };
    if (d.type === 'number' && !Number.isInteger(Number(v))) return { ok: false, error: `Ogiltigt tal: ${d.q}` };
    b[d.id] = String(v).slice(0, 32);
  }
  return { ok: true, b };
}

// The 1X2 outcome is always derived from the score — never stored/read as a separate
// field. This is deliberate: a stored pick that disagrees with the stored score (the
// exact bug that hit one player's prediction) is now structurally impossible.
function derivePick(hs, as) {
  const h = Number(hs), a = Number(as);
  return h > a ? '1' : h < a ? '2' : 'X';
}

// Scoring: 3 for 1X2 (derived from scores on both sides), 1 exact home, 1 exact away,
// +1 per correct bonus (when the result carries bonusDefs + actual answers in `b`).
// Base max 5; bonuses add on top.
function computePoints(pred, result) {
  const hs = result.hs, as = result.as;
  const actual = derivePick(hs, as);
  const r1x2 = derivePick(pred.hs, pred.as) === actual;
  const rh = Number(pred.hs) === hs;
  const ra = Number(pred.as) === as;
  let pts = (r1x2 ? 3 : 0) + (rh ? 1 : 0) + (ra ? 1 : 0);
  const bonus = [];
  const defs = result.bonusDefs || [];
  for (const d of defs) {
    const ans = pred.b ? pred.b[d.id] : undefined;
    const act = result.b ? result.b[d.id] : undefined;
    let correct = false;
    if (ans != null && ans !== '' && act != null && act !== '') {
      correct = d.type === 'number' ? Number(ans) === Number(act) : String(ans) === String(act);
    }
    if (correct) pts += 1;
    bonus.push({ id: d.id, q: d.q, correct, answer: ans, actual: act });
  }
  return { pts, r1x2, rh, ra, actual, bonus };
}

// Grade once (idempotent via NX guard). Records exact per-player points so a regrade
// can reverse them precisely. Returns true if it graded, false if already graded.
// `result` = { hs, as, b?:{id->actual}, bonusDefs?:[...] }
async function gradeMatch(matchId, result) {
  const [got] = await kv([['SET', `1x2:graded:${matchId}`, '1', 'NX']]);
  if (got !== 'OK') return false;
  const [raw, beforeRaw] = await kv([
    ['HGETALL', `1x2:pred:${matchId}`],
    ['ZREVRANGE', '1x2:season', '0', '-1', 'WITHSCORES'],
  ]);
  const preds = hashToObj(raw);
  const before = rowsFromWithScores(beforeRaw);
  const cmds = [];
  const applied = [];
  const roundPts = {};
  for (const [pid, json] of Object.entries(preds)) {
    let pred;
    try { pred = JSON.parse(json); } catch { continue; }
    const { pts } = computePoints(pred, result);
    roundPts[pid] = pts;
    cmds.push(['ZADD', `1x2:daily:${matchId}`, String(pts), pid]);
    cmds.push(['ZINCRBY', '1x2:season', String(pts), pid]);
    applied.push(pid, String(pts));
  }
  if (applied.length) cmds.push(['HSET', `1x2:applied:${matchId}`, ...applied]);
  cmds.push(['SET', `1x2:result:${matchId}`, JSON.stringify(result)]);
  await kv(cmds);

  // Best-effort storyline blurb for this match ("Snacket") — never let it fail grading.
  try { await writeCommentary(matchId, before, roundPts); } catch (_) {}

  return true;
}

// ── "Snacket" — one auto-generated storyline line per graded match ────────────
// Replaced every time a match is graded (or regraded) — deliberately only ever
// shows the latest one, no accumulating history, so it always has full context.
function rowsFromWithScores(raw) {
  const out = [];
  if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) out.push({ id: raw[i], pts: Number(raw[i + 1]) });
  return out;
}
// Dense, tie-aware rank (same rule as the front-end leaderboard: equal scores share a rank).
function ranksOf(rows) {
  const uniq = [...new Set(rows.map((r) => r.pts))].sort((a, b) => b - a);
  const map = {};
  rows.forEach((r) => { map[r.id] = uniq.indexOf(r.pts) + 1; });
  return map;
}

async function writeCommentary(matchId, before, roundPts) {
  const participantIds = Object.keys(roundPts);
  if (!participantIds.length) return;

  const [afterRaw] = await kv([['ZREVRANGE', '1x2:season', '0', '-1', 'WITHSCORES']]);
  const after = rowsFromWithScores(afterRaw);
  const idsNeeded = [...new Set([...before.map((r) => r.id), ...after.map((r) => r.id)])];
  const [namesRaw] = await kv([['HMGET', '1x2:names', ...idsNeeded]]);
  const nameOf = {};
  idsNeeded.forEach((id, i) => { nameOf[id] = (Array.isArray(namesRaw) && namesRaw[i]) || 'Anonym'; });

  const beforeRank = ranksOf(before), afterRank = ranksOf(after);
  const beforePts = Object.fromEntries(before.map((r) => [r.id, r.pts]));
  const afterPts = Object.fromEntries(after.map((r) => [r.id, r.pts]));
  const MAX_ROUND_PTS = 10; // 3+1+1 base + 5 bonus questions, every match

  const positives = [], negatives = [];

  // Biggest rank climb / drop this round (only for players already on the board before).
  let bestClimb = null, worstDrop = null;
  for (const id of participantIds) {
    if (beforeRank[id] == null || afterRank[id] == null) continue;
    const delta = beforeRank[id] - afterRank[id]; // positive = moved up
    if (delta > 0 && (!bestClimb || delta > bestClimb.delta)) bestClimb = { id, delta, before: beforeRank[id], after: afterRank[id] };
    if (delta < 0 && (!worstDrop || delta < worstDrop.delta)) worstDrop = { id, delta, before: beforeRank[id], after: afterRank[id] };
  }
  if (bestClimb && bestClimb.delta >= 2) positives.push({ pri: 3, text: `${nameOf[bestClimb.id]} klev från ${bestClimb.before}:a till ${bestClimb.after}:a plats efter senaste omgången!` });
  if (worstDrop && worstDrop.delta <= -2) negatives.push({ pri: 3, text: `${nameOf[worstDrop.id]} rasade från ${worstDrop.before}:a till ${worstDrop.after}:a plats — vad hände där?` });

  // Full pott / zero pott this specific round.
  for (const id of participantIds) {
    if (roundPts[id] === MAX_ROUND_PTS) positives.push({ pri: 4, text: `${nameOf[id]} tog fullpott (${MAX_ROUND_PTS}p) denna omgång — kan hen upprepa bedriften?` });
    if (roundPts[id] === 0) negatives.push({ pri: 2, text: `${nameOf[id]} fick 0p denna omgång. Tur att det bara är på skoj... eller?` });
  }

  // Leadership change / lead extended.
  const leaderBeforeId = before.find((r) => beforeRank[r.id] === 1)?.id;
  const leaderAfterId = after.find((r) => afterRank[r.id] === 1)?.id;
  if (leaderBeforeId && leaderAfterId && leaderBeforeId !== leaderAfterId) {
    positives.push({ pri: 6, text: `Ny serieledare! ${nameOf[leaderAfterId]} går om ${nameOf[leaderBeforeId]} i toppen.` });
    negatives.push({ pri: 6, text: `${nameOf[leaderBeforeId]} tappade förstaplatsen efter en katastrofal omgång.` });
  } else if (leaderAfterId && leaderBeforeId === leaderAfterId) {
    const secondBefore = Math.max(0, ...before.filter((r) => r.id !== leaderBeforeId).map((r) => r.pts), 0);
    const secondAfter = Math.max(0, ...after.filter((r) => r.id !== leaderAfterId).map((r) => r.pts), 0);
    const gapAfter = (afterPts[leaderAfterId] || 0) - secondAfter;
    const gapBefore = (beforePts[leaderBeforeId] || 0) - secondBefore;
    if (gapAfter > gapBefore) positives.push({ pri: 2, text: `${nameOf[leaderAfterId]} befäste ledningen — försprånget är nu ${gapAfter}p.` });
  }

  // Best / worst tip of this specific round.
  if (participantIds.length > 1) {
    let bestId = null, bestVal = -1, worstId = null, worstVal = Infinity;
    for (const id of participantIds) {
      if (roundPts[id] > bestVal) { bestVal = roundPts[id]; bestId = id; }
      if (roundPts[id] < worstVal) { worstVal = roundPts[id]; worstId = id; }
    }
    if (bestId && bestVal > 0) positives.push({ pri: 1, text: `${nameOf[bestId]} hade bästa tipset i omgången med ${bestVal}p.` });
    if (worstId && worstVal < MAX_ROUND_PTS) negatives.push({ pri: 1, text: `${nameOf[worstId]} gissade sämst i omgången med bara ${worstVal}p.` });
  }

  // Bottom-to-top comeback / stuck-at-the-bottom roast. Only meaningful once the
  // board is big enough that "top 3" and "bottom 3" don't trivially overlap
  // (mirrors the tie threshold used by the front-end leaderboard's own coloring),
  // and only when the player's rank actually improved/stayed — not just a
  // before/after snapshot that happens to satisfy both tiers in a tiny league.
  if (after.length >= 6) {
    for (const id of participantIds) {
      if (beforeRank[id] == null || afterRank[id] == null) continue;
      const wasBottom = beforeRank[id] > Math.max(1, before.length - 3);
      const nowBottom = afterRank[id] > Math.max(1, after.length - 3);
      if (wasBottom && afterRank[id] <= 3 && afterRank[id] < beforeRank[id]) {
        positives.push({ pri: 5, text: `Från botten till toppen! ${nameOf[id]} klev hela vägen upp till ${afterRank[id]}:a plats.` });
      } else if (wasBottom && nowBottom) {
        negatives.push({ pri: 1, text: `${nameOf[id]} sitter fortfarande fast i botten av tabellen.` });
      }
    }
  }

  if (!positives.length && !negatives.length) return;
  // Aim for a 50/50 split of tone over time, but always show something —
  // fall back to whichever pool actually has a candidate this round.
  const preferPositive = Math.random() < 0.5;
  let pool = preferPositive ? positives : negatives;
  let sentiment = preferPositive ? 'pos' : 'neg';
  if (!pool.length) { pool = preferPositive ? negatives : positives; sentiment = preferPositive ? 'neg' : 'pos'; }
  pool.sort((a, b) => b.pri - a.pri);

  await kv([['SET', '1x2:commentary', JSON.stringify({ matchId, text: pool[0].text, sentiment, at: Date.now() })]]);
}

async function getCommentary() {
  const [v] = await kv([['GET', '1x2:commentary']]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// Re-derive a match's storyline from CURRENT truth rather than a frozen
// snapshot: "before" = current season score minus this match's own applied
// deltas (1x2:applied is the exact per-player ledger gradeMatch already keeps
// for regrade purposes). This makes the commentary self-healing — callable
// any time after an identity merge or correction changes who a match's points
// actually belong to, not just once at grading time.
async function regenerateCommentary(matchId) {
  const [appliedRaw, seasonRaw] = await kv([
    ['HGETALL', `1x2:applied:${matchId}`],
    ['ZREVRANGE', '1x2:season', '0', '-1', 'WITHSCORES'],
  ]);
  const applied = hashToObj(appliedRaw);
  const roundPts = {};
  for (const [pid, pts] of Object.entries(applied)) roundPts[pid] = Number(pts);
  if (!Object.keys(roundPts).length) return;
  const after = rowsFromWithScores(seasonRaw);
  const before = after.map((r) => ({ id: r.id, pts: r.pts - (roundPts[r.id] || 0) }));
  await writeCommentary(matchId, before, roundPts);
}

// Reassign a set of merged-away playerIDs to the surviving target id across
// every match's per-match records (predictions, that match's daily points,
// and its applied-points ledger) — not just the season total. Without this,
// a merge leaves old matches pointing at a now-nameless id (shows "Anonym" in
// Vännernas Tips) and, worse, a future regrade of that match would reverse
// points against an id that no longer exists in 1x2:season, resurrecting it
// with a negative score. Returns the list of matchIds actually touched.
async function reassignPlayerAcrossMatches(sourceIds, targetId) {
  const [histRaw] = await kv([['ZREVRANGE', '1x2:history', '0', '-1']]);
  const matchIds = Array.isArray(histRaw) ? histRaw : [];
  const affected = [];
  for (const matchId of matchIds) {
    const [predRaw, dailyRaw, appliedRaw] = await kv([
      ['HGETALL', `1x2:pred:${matchId}`],
      ['ZRANGE', `1x2:daily:${matchId}`, '0', '-1', 'WITHSCORES'],
      ['HGETALL', `1x2:applied:${matchId}`],
    ]);
    const preds = hashToObj(predRaw);
    const daily = rowsFromWithScores(dailyRaw);
    const dailyMap = Object.fromEntries(daily.map((r) => [r.id, r.pts]));
    const applied = hashToObj(appliedRaw);
    const cmds = [];
    for (const sid of sourceIds) {
      if (preds[sid] != null) {
        if (preds[targetId] == null) cmds.push(['HSET', `1x2:pred:${matchId}`, targetId, preds[sid]]);
        cmds.push(['HDEL', `1x2:pred:${matchId}`, sid]);
      }
      if (dailyMap[sid] != null) {
        cmds.push(['ZREM', `1x2:daily:${matchId}`, sid]);
        cmds.push(['ZINCRBY', `1x2:daily:${matchId}`, String(dailyMap[sid]), targetId]);
      }
      if (applied[sid] != null) {
        const merged = Number(applied[targetId] || 0) + Number(applied[sid]);
        cmds.push(['HSET', `1x2:applied:${matchId}`, targetId, String(merged)]);
        cmds.push(['HDEL', `1x2:applied:${matchId}`, sid]);
      }
    }
    if (cmds.length) { await kv(cmds); affected.push(matchId); }
  }
  return affected;
}

// Reverse a prior grading exactly, then grade again with the corrected result.
async function regradeMatch(matchId, result) {
  const [raw] = await kv([['HGETALL', `1x2:applied:${matchId}`]]);
  const applied = hashToObj(raw);
  const cmds = [];
  for (const [pid, pts] of Object.entries(applied)) {
    cmds.push(['ZINCRBY', '1x2:season', String(-Number(pts)), pid]);
  }
  cmds.push(
    ['DEL', `1x2:daily:${matchId}`],
    ['DEL', `1x2:applied:${matchId}`],
    ['DEL', `1x2:graded:${matchId}`],
    ['DEL', `1x2:result:${matchId}`],
  );
  await kv(cmds);
  await gradeMatch(matchId, result);
}

// ── Leaderboards ──────────────────────────────────────────────────────────────
async function zTop(key, n) {
  const [res] = await kv([['ZREVRANGE', key, '0', String(n - 1), 'WITHSCORES']]);
  const out = [];
  if (Array.isArray(res)) for (let i = 0; i < res.length; i += 2) out.push({ id: res[i], pts: Number(res[i + 1]) });
  return out;
}

// All predictions for a match, with player names resolved.
async function getPredictions(matchId) {
  const [raw] = await kv([['HGETALL', `1x2:pred:${matchId}`]]);
  const obj = hashToObj(raw);
  const ids = Object.keys(obj);
  if (!ids.length) return [];
  const [names] = await kv([['HMGET', '1x2:names', ...ids]]);
  return ids.map((id, i) => {
    let pr = {};
    try { pr = JSON.parse(obj[id]); } catch (_) {}
    // p is always derived from hs/as (never stored/trusted) — see derivePick().
    return { id, name: (Array.isArray(names) && names[i]) || 'Anonym', p: derivePick(pr.hs, pr.as), hs: pr.hs, as: pr.as, b: pr.b || null };
  });
}

// Set (or overwrite) one player's raw prediction for a match — used by the admin
// panel to fix a broken/incomplete submission. Does not grade; call gradeMatch or
// regradeMatch afterwards if the match already has a result.
async function setPrediction(matchId, playerID, name, hs, as, b) {
  const member = JSON.stringify({ hs: Number(hs), as: Number(as), b: b || {} });
  const cmds = [['HSET', `1x2:pred:${matchId}`, playerID, member]];
  if (name) cmds.push(['HSET', '1x2:names', playerID, String(name).slice(0, 20)]);
  await kv(cmds);
}

// Find a playerID by (case-insensitive) display name among this match's predictions —
// so the admin can identify "Mint" without needing to know her stable playerID.
async function findPlayerByName(matchId, name) {
  const preds = await getPredictions(matchId);
  const needle = String(name).trim().toLowerCase();
  return preds.find((p) => p.name.trim().toLowerCase() === needle) || null;
}

// Find any existing playerID by (case-insensitive) display name across the whole
// game — not just this match. Used by fixPrediction so correcting/adding a tip for
// someone who already has a season identity (just didn't predict *this* match)
// reuses their real ID instead of minting a disconnected "manual-x" one that
// orphans their points from the rest of their season total.
async function findAnyPlayerIdByName(name) {
  const [namesRaw] = await kv([['HGETALL', '1x2:names']]);
  const namesObj = hashToObj(namesRaw);
  const needle = String(name).trim().toLowerCase();
  const id = Object.keys(namesObj).find((pid) => String(namesObj[pid]).trim().toLowerCase() === needle);
  return id || null;
}

async function attachNames(rows) {
  if (!rows.length) return rows;
  const [names] = await kv([['HMGET', '1x2:names', ...rows.map((r) => r.id)]]);
  rows.forEach((r, i) => { r.name = (Array.isArray(names) && names[i]) || 'Anonym'; });
  return rows;
}

// "Svårast match att tippa hittills" — rank every graded match by the average
// points awarded per player who predicted it (total points / player count).
// Lower average = tougher to call. Uses 1x2:history (every match ever pinned,
// kept indefinitely — see 1x2:matchmeta) so it covers the full season, not
// just recently-played matches.
async function toughestMatches(limit = 20) {
  const [ids] = await kv([['ZREVRANGE', '1x2:history', '0', '-1']]);
  const idList = Array.isArray(ids) ? ids : [];
  if (!idList.length) return [];
  const cmds = [];
  for (const id of idList) {
    cmds.push(['GET', `1x2:matchmeta:${id}`]);
    cmds.push(['GET', `1x2:result:${id}`]);
    cmds.push(['ZRANGE', `1x2:daily:${id}`, '0', '-1', 'WITHSCORES']);
  }
  const rows = await kv(cmds);
  const out = [];
  for (let i = 0; i < idList.length; i++) {
    const metaRaw = rows[i * 3], resultRaw = rows[i * 3 + 1], scoresRaw = rows[i * 3 + 2];
    if (!metaRaw || !resultRaw) continue; // only graded matches count
    let m; try { m = JSON.parse(metaRaw); } catch { continue; }
    const scores = Array.isArray(scoresRaw) ? scoresRaw : [];
    let total = 0, players = 0;
    for (let j = 1; j < scores.length; j += 2) { total += Number(scores[j]); players++; }
    if (!players) continue;
    out.push({
      matchId: idList[i], home: m.home, away: m.away, group: m.group, stage: m.stage,
      dateStr: m.dateStr, players, totalPoints: total, avg: total / players,
    });
  }
  out.sort((a, b) => a.avg - b.avg);
  return out.slice(0, limit);
}

module.exports = {
  kv, kvReady, getData, todayStockholm, stockholmDateStr, venueDateStr, kickoffMs,
  normalizeFeedMatch, pickMatchOfDay, nextMatch, resolveMatch, getOverride,
  getResult, computePoints, gradeMatch, regradeMatch, zTop, attachNames, getPredictions,
  buildBonus, getCurrent, derivePick, setPrediction, findPlayerByName, findAnyPlayerIdByName, validateBonusAnswers,
  hashToObj, toughestMatches, getCommentary, regenerateCommentary, reassignPlayerAcrossMatches,
};
