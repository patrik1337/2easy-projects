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
// Backfill .bonus on any match missing it (e.g. one pinned before the bonus feature
// existed, or a fresh feed pick) — deterministic and idempotent, safe to call always.
function withBonus(match) {
  if (!Array.isArray(match.bonus) || !match.bonus.length) match.bonus = buildBonus(match);
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
    { id: 'penalties', q: 'Avgörs matchen på straffar?', type: 'choice', options: ['Ja', 'Nej'] },
    { id: 'possession', q: 'Högst bollinnehav?', type: 'choice', options: [H, A] },
    { id: 'redcard', q: 'Blir det rött kort?', type: 'choice', options: ['Ja', 'Nej'] },
    { id: 'corners', q: 'Flest hörnor?', type: 'choice', options: [H, A, 'Lika'] },
  ];
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
  const [raw] = await kv([['HGETALL', `1x2:pred:${matchId}`]]);
  const preds = hashToObj(raw);
  const cmds = [];
  const applied = [];
  for (const [pid, json] of Object.entries(preds)) {
    let pred;
    try { pred = JSON.parse(json); } catch { continue; }
    const { pts } = computePoints(pred, result);
    cmds.push(['ZADD', `1x2:daily:${matchId}`, String(pts), pid]);
    cmds.push(['ZINCRBY', '1x2:season', String(pts), pid]);
    applied.push(pid, String(pts));
  }
  if (applied.length) cmds.push(['HSET', `1x2:applied:${matchId}`, ...applied]);
  cmds.push(['SET', `1x2:result:${matchId}`, JSON.stringify(result)]);
  await kv(cmds);
  return true;
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

async function attachNames(rows) {
  if (!rows.length) return rows;
  const [names] = await kv([['HMGET', '1x2:names', ...rows.map((r) => r.id)]]);
  rows.forEach((r, i) => { r.name = (Array.isArray(names) && names[i]) || 'Anonym'; });
  return rows;
}

module.exports = {
  kv, kvReady, getData, todayStockholm, stockholmDateStr, venueDateStr, kickoffMs,
  normalizeFeedMatch, pickMatchOfDay, nextMatch, resolveMatch, getOverride,
  getResult, computePoints, gradeMatch, regradeMatch, zTop, attachNames, getPredictions,
  buildBonus, getCurrent, derivePick, setPrediction, findPlayerByName,
};
