// Simulator UI. Session experiments live in `session` (URL-encoded); data.json
// defaults are frozen and never mutated. Every view reads one simulation result.
import { compileModel, evaluateActual, curveTiers, tierIndex } from './engine.js';
import { buildEngineInput, calibrateTitle, methodOptions, spanAt, actualPositions } from './calibration.js';
import * as S from './stats.js';
import { deepFreeze, defaultSession, decodeSession, encodeSession, setOverride } from './state.js';
import { investmentMetrics } from './investment.js';
import { placementChart } from './charts.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => n == null ? '—' : Math.round(n).toLocaleString('en-US');
const fmtPct = p => {
  if (p == null) return '—';
  if (p === 0) return '0%';
  if (p === 1) return '100%';
  if (p < 0.001) return '<0.1%';
  if (p > 0.999) return '>99.9%';
  return (p * 100).toFixed(1) + '%';
};
const fmtW = w => w >= 100 ? w.toFixed(0) : w >= 1 ? w.toFixed(2) : w.toPrecision(3);
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

let DATA, MODEL0, ACTUAL, CLUBS, CLUB_INDEX, RANK_GROUP, CLUB_TITLES, SEARCH;
let session;
let results = null;            // { key, runs, seed, a, b, provA, provB, ms }
let worker = null, jobId = 0, runTimer = null, runStarted = 0;
let tableSort = { key: 'pTop8', dir: -1 };
let tableFilter = '';

// ------------------------------------------------------------------ boot

async function boot() {
  const res = await fetch('data.json', { cache: 'no-cache' });
  DATA = deepFreeze(await res.json());
  const { input, clubIndex } = buildEngineInput(DATA);
  MODEL0 = compileModel(input);
  CLUBS = input.clubs;
  CLUB_INDEX = clubIndex;
  ACTUAL = evaluateActual(MODEL0, actualPositions(DATA));
  RANK_GROUP = new Map();
  for (let c = 0; c < CLUBS.length; c++) RANK_GROUP.set(ACTUAL.rank[c], (RANK_GROUP.get(ACTUAL.rank[c]) || 0) + 1);
  CLUB_TITLES = CLUBS.map(() => []);
  DATA.titles.forEach((t, ti) => {
    const seen = new Set();
    t.entries.forEach(e => {
      const c = CLUB_INDEX.get(e.canonical);
      if (c !== undefined && !seen.has(c)) { seen.add(c); CLUB_TITLES[c].push(ti); }
    });
  });
  const registry = new Map(DATA.clubs.map(c => [c.name, c]));
  SEARCH = CLUBS.map((name, c) => {
    const r = registry.get(name) || {};
    const alt = [...new Set([...(r.aliases || []), ...(r.entrantNames || [])])];
    return { c, name, alt, hay: [name, ...alt].map(s => s.toLowerCase()) };
  });

  session = decodeSession(DATA, location.hash);
  $('#source-note').textContent = `${DATA.source.workbook} · sha ${DATA.source.sha256.slice(0, 10)} · ${DATA.titles.length} titles · ${CLUBS.length} clubs`;
  bindControls();
  window.addEventListener('hashchange', () => {
    const next = decodeSession(DATA, location.hash);
    if (encodeSession(DATA, next) !== encodeSession(DATA, session)) { session = next; afterChange(true); }
  });
  afterChange(true, 0);
}

// ------------------------------------------------------------------ session

function paramKey(s) {
  return JSON.stringify([s.runs, s.seed, s.compare, s.sets.a, s.compare ? s.sets.b : null]);
}

function update(mutate, { rerun = false, delay = 450 } = {}) {
  session = mutate(session);
  afterChange(rerun, delay);
}

function afterChange(rerun, delay = 450) {
  const enc = encodeSession(DATA, session);
  const url = location.pathname + location.search + (enc ? '#' + enc : '');
  if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
  syncControls();
  if (rerun && (!results || results.key !== paramKey(session))) scheduleRun(delay);
  render();
}

function scheduleRun(delay) {
  clearTimeout(runTimer);
  runTimer = setTimeout(startRun, delay);
  setStatus('Parameters changed — running shortly…', true);
}

function startRun() {
  clearTimeout(runTimer);
  if (worker) worker.terminate();               // cancel any in-flight job
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  const snap = structuredClone({ runs: session.runs, seed: session.seed, compare: session.compare, sets: session.sets });
  const a = buildEngineInput(DATA, { titles: snap.sets.a });
  const b = snap.compare ? buildEngineInput(DATA, { titles: snap.sets.b }) : null;
  runStarted = performance.now();
  setProgress(0);
  setStatus(`Running ${fmtInt(snap.runs)} runs${snap.compare ? ' × 2 sets' : ''}…`, false);
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.jobId !== id) return;
    if (msg.type === 'progress') setProgress(msg.done / msg.total);
    else if (msg.type === 'error') setStatus(`Simulation failed: ${msg.message}`, true);
    else if (msg.type === 'done') {
      results = {
        key: paramKey({ ...session, ...snap }),
        runs: snap.runs, seed: snap.seed, compare: snap.compare,
        a: msg.results[0], b: msg.results[1] || null,
        provA: a.provenance, provB: b ? b.provenance : null,
        ms: performance.now() - runStarted,
      };
      setProgress(1);
      render();
    }
  };
  worker.postMessage({ jobId: id, sets: b ? [a.input, b.input] : [a.input], runs: snap.runs, seed: snap.seed });
}

function setProgress(f) { $('#progress-bar').style.width = `${Math.round(f * 100)}%`; }
function setStatus(text, stale) {
  const el = $('#run-status');
  el.textContent = text;
  el.classList.toggle('stale', !!stale);
}

// ------------------------------------------------------------------ controls

function bindControls() {
  $('#ctl-runs').addEventListener('change', e => {
    const v = Math.min(500000, Math.max(100, Math.round(Number(e.target.value) || DATA.simulationDefaults.runs)));
    update(s => ({ ...s, runs: v }), { rerun: true, delay: 0 });
  });
  $('#ctl-seed').addEventListener('change', e => {
    const v = Math.round(Number(e.target.value));
    update(s => ({ ...s, seed: Number.isFinite(v) ? v : DATA.simulationDefaults.rngSeed }), { rerun: true, delay: 0 });
  });
  $('#btn-run').addEventListener('click', startRun);
  $('#ctl-compare').addEventListener('change', e => update(s => ({ ...s, compare: e.target.checked, editing: e.target.checked ? s.editing : 'a' }), { rerun: true, delay: 0 }));
  $('#seg-editing').addEventListener('click', e => {
    const set = e.target.dataset.set;
    if (set) update(s => ({ ...s, editing: set }));
  });
  $('#btn-reset').addEventListener('click', () => {
    const def = defaultSession(DATA);
    update(s => ({ ...def, view: s.view, club: s.club, club2: s.club2, titleId: s.titleId }), { rerun: true, delay: 0 });
  });
  $('#btn-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); setStatus('Link copied', false); } catch { prompt('Copy this link', location.href); }
  });
  $('#section-nav').addEventListener('click', e => {
    const v = e.target.dataset.view;
    if (v) update(s => ({ ...s, view: v }));
  });
}

function syncControls() {
  const def = defaultSession(DATA);
  $('#ctl-runs').value = session.runs;
  $('#ctl-seed').value = session.seed;
  markMod('#mod-runs', session.runs !== def.runs, `Default: ${fmtInt(def.runs)} runs`);
  markMod('#mod-seed', session.seed !== def.seed, `Default: seed ${def.seed}`);
  $('#ctl-compare').checked = session.compare;
  $('#seg-editing').classList.toggle('hidden', !session.compare);
  $('#seg-editing').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.set === session.editing));
  document.querySelectorAll('.section-tab').forEach(b => b.classList.toggle('active', b.dataset.view === session.view));
  renderBanner();
}

function markMod(sel, on, title) {
  const el = $(sel);
  el.classList.toggle('hidden', !on);
  el.title = on ? `Modified from default — ${title}` : '';
}

const modMarker = (on, def) => on ? `<span class="mod" title="Modified from default — default: ${esc(def)}">●</span>` : '';

function renderBanner() {
  const approved = DATA.titles.filter(t => DATA.calibration.approved[t.id]);
  const list = approved.map(t => `${esc(t.short)} · TVI ${DATA.calibration.approved[t.id].tvi}`).join(', ') || 'none';
  const nMod = Object.keys(session.sets.a).length + (session.compare ? Object.keys(session.sets.b).length : 0);
  $('#calibration-banner').innerHTML =
    `<b>${approved.length} of ${DATA.titles.length} titles calibrated</b> (${list}, approved). ` +
    `The other ${DATA.titles.length - approved.length} run on a <b>provisional TVI ${DATA.calibration.provisionalTvi}</b>, marked ` +
    `<span class="badge provisional">provisional</span> wherever they feed a result.` +
    (nMod ? ` <b>${nMod}</b> session override${nMod > 1 ? 's' : ''} active <span class="badge session">session</span> — defaults in data.json are untouched.` : '');
}

// ------------------------------------------------------------------ shared helpers

const tvBadge = prov => {
  if (!prov) return '';
  const src = prov.tvi.source;
  const label = src === 'approved' ? `approved TVI ${prov.tvi.tvi}` : src === 'session' ? `session TVI ${prov.tvi.tvi}` : `provisional TVI ${prov.tvi.tvi}`;
  return `<span class="badge ${src}" title="${src === 'session' ? `Default: ${prov.tvi.defaultSource} TVI ${prov.tvi.defaultTvi}` : ''}">${label}</span>` +
    (prov.method === 'random' ? '<span class="badge session">random</span>' : '');
};

function clubCalibration(c, prov) {
  let appr = 0, provisional = 0, sess = 0;
  for (const ti of CLUB_TITLES[c]) {
    const p = prov[DATA.titles[ti].id];
    if (p.tvi.source === 'session' || p.method === 'random') sess++;
    else if (p.tvi.source === 'approved') appr++;
    else provisional++;
  }
  const bits = [];
  if (appr) bits.push(`<span class="badge approved" title="Titles on an approved TVI">${appr} approved</span>`);
  if (provisional) bits.push(`<span class="badge provisional" title="Titles on the provisional TVI">${provisional} provisional</span>`);
  if (sess) bits.push(`<span class="badge session" title="Titles with session overrides">${sess} session</span>`);
  return bits.join('');
}

const actualRankLabel = c => {
  const r = ACTUAL.rank[c];
  return `${r}${RANK_GROUP.get(r) > 1 ? '=' : ''}`;
};

function ab(fn, fmt) {
  const a = fmt(fn(results.a));
  if (!results.b) return a;
  return `<span class="aval">${a}</span><span class="bval" title="Parameter set B">${fmt(fn(results.b))}</span>`;
}

function waitingMsg() {
  return `<p class="muted">${results ? '' : 'Simulation running…'}</p>`;
}

const TIE_RULE_HTML = () => `<p class="rule-note"><b>Ranking rule:</b> ${esc(DATA.ccRules.tieRule)} Only a club's best entry per title scores; the points its other entries would have earned go to nobody. <a href="${esc(DATA.ccRules.source)}" target="_blank" rel="noopener">EWC rules</a>.</p>`;

function staleNote() {
  return results && results.key !== paramKey(session)
    ? '<p class="rule-note" style="color:var(--accent)">Showing the previous run — parameters have changed and a new run is queued.</p>' : '';
}

// ------------------------------------------------------------------ render

function render() {
  if (results) {
    const stale = results.key !== paramKey(session);
    if (!stale) setStatus(`${fmtInt(results.runs)} runs${results.compare ? ' × 2 sets' : ''} · seed ${results.seed} · ${(results.ms / 1000).toFixed(1)}s`, false);
  }
  const views = { summary: viewSummary, table: viewTable, titles: viewTitles, focus: viewFocus, investment: viewInvestment, method: viewMethod };
  const panel = $('#panel');
  const scroll = window.scrollY;
  panel.innerHTML = (views[session.view] || viewSummary)();
  bindPanel(session.view);
  window.scrollTo(0, scroll);
}

function bindPanel(view) {
  document.querySelectorAll('[data-club]').forEach(el => el.addEventListener('click', () => {
    update(s => ({ ...s, view: 'focus', club: el.dataset.club }));
    window.scrollTo(0, 0);
  }));
  if (view === 'table') bindTable();
  if (view === 'titles') bindTitles();
  if (view === 'focus') bindFocus();
}

const COLS = [
  { key: 'pExactActual', label: 'P(actual rank)', fmt: fmtPct, title: 'Simulated probability of finishing in exactly the position actually achieved' },
  { key: 'pTop3', label: 'P(top 3)', fmt: fmtPct },
  { key: 'pTop8', label: 'P(top 8)', fmt: fmtPct },
  { key: 'medianRank', label: 'Median rank', fmt: v => fmtInt(v) },
  { key: 'meanPoints', label: 'Mean pts', fmt: fmtInt, title: 'Club totals are sums across titles, so a mean is meaningful here' },
  { key: 'p10p90', label: 'P10–P90 pts', fmt: v => v, raw: (res, c) => { const s = S.clubSummary(res, c, ACTUAL); return `${fmtInt(s.p10)}–${fmtInt(s.p90)}`; } },
];

function summaryCells(c) {
  return COLS.map(col => `<td class="num" ${col.title ? `title="${esc(col.title)}"` : ''}>${ab(res => col.raw ? col.raw(res, c) : S.clubSummary(res, c, ACTUAL)[col.key], col.raw ? v => v : col.fmt)}</td>`).join('');
}

function viewSummary() {
  const top = [...Array(CLUBS.length).keys()].filter(c => ACTUAL.rank[c] <= 8)
    .sort((x, y) => ACTUAL.rank[x] - ACTUAL.rank[y] || ACTUAL.total[y] - ACTUAL.total[x]);
  const head = `<h2>The actual top eight, against the simulation</h2>
    <p class="lede">The eight clubs that finished top eight in 2026, in order, with how often the pre-event seeds produced exactly that finish. ${results?.b ? 'Blue second lines are parameter set B.' : ''}</p>${TIE_RULE_HTML()}`;
  if (!results) return head + waitingMsg();
  return head + staleNote() + `<div class="table-scroll"><table class="data">
    <thead><tr><th>Actual</th><th>Club</th><th class="num">Actual pts</th>${COLS.map(c => `<th class="num" title="${esc(c.title || '')}">${c.label}</th>`).join('')}<th>Titles by TVI status</th></tr></thead>
    <tbody>${top.map(c => `<tr class="clickable" data-club="${esc(CLUBS[c])}">
      <td class="rank">${actualRankLabel(c)}</td><td class="club">${esc(CLUBS[c])}</td>
      <td class="num">${fmtInt(ACTUAL.total[c])}</td>${summaryCells(c)}<td>${clubCalibration(c, results.provA)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function viewTable() {
  const head = `<h2>Club Championship — simulated vs actual</h2>
    <p class="lede">Every club with at least one entry. Probabilities are over ${results ? fmtInt(results.runs) : '…'} runs. Click a club for its full placement distribution.</p>${TIE_RULE_HTML()}`;
  if (!results) return head + waitingMsg();
  const rows = [...Array(CLUBS.length).keys()].map(c => ({ c, name: CLUBS[c], s: S.clubSummary(results.a, c, ACTUAL), n: CLUB_TITLES[c].length }));
  const q = tableFilter.toLowerCase();
  const shown = rows.filter(r => !q || SEARCH[r.c].hay.some(h => h.includes(q)));
  const val = (r, k) => k === 'name' ? r.name : k === 'titles' ? r.n : k === 'actualRank' ? ACTUAL.rank[r.c] : k === 'actualPoints' ? ACTUAL.total[r.c] : r.s[k];
  shown.sort((x, y) => {
    const a = val(x, tableSort.key), b = val(y, tableSort.key);
    return (typeof a === 'string' ? a.localeCompare(b) : (a ?? -1) - (b ?? -1)) * tableSort.dir || y.s.meanPoints - x.s.meanPoints;
  });
  const th = (key, label, num = true, title = '') =>
    `<th class="sortable ${num ? 'num' : ''} ${tableSort.key === key ? 'sorted' : ''}" data-sort="${key}" title="${esc(title)}">${label}${tableSort.key === key ? (tableSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  return head + staleNote() + `<div class="ctl" style="margin-bottom:10px"><input type="search" id="table-filter" placeholder="Filter clubs (names and aliases)" value="${esc(tableFilter)}" style="width:300px" /> <span>${shown.length} of ${rows.length}</span></div>
    <div class="table-scroll"><table class="data">
    <thead><tr>${th('actualRank', 'Actual')}${th('name', 'Club', false)}${th('titles', 'Titles')}${th('actualPoints', 'Actual pts')}
      ${th('pExactActual', 'P(actual rank)', true, COLS[0].title)}${th('pWin', 'P(win)')}${th('pTop3', 'P(top 3)')}${th('pTop8', 'P(top 8)')}${th('pTop24', 'P(top 24)')}
      ${th('medianRank', 'Median rank')}${th('meanPoints', 'Mean pts')}<th class="num">P10–P90</th><th>TVI status</th></tr></thead>
    <tbody>${shown.map(r => {
      const c = r.c, f = (k, fmt) => ab(res => S.clubSummary(res, c, ACTUAL)[k], fmt);
      return `<tr class="clickable" data-club="${esc(r.name)}">
        <td class="rank">${actualRankLabel(c)}</td><td class="club">${esc(r.name)}</td><td class="num">${r.n}</td><td class="num">${fmtInt(ACTUAL.total[c])}</td>
        <td class="num">${f('pExactActual', fmtPct)}</td><td class="num">${f('pWin', fmtPct)}</td><td class="num">${f('pTop3', fmtPct)}</td>
        <td class="num">${f('pTop8', fmtPct)}</td><td class="num">${f('pTop24', fmtPct)}</td><td class="num">${f('medianRank', fmtInt)}</td>
        <td class="num">${f('meanPoints', fmtInt)}</td><td class="num">${ab(res => { const s = S.clubSummary(res, c, ACTUAL); return `${fmtInt(s.p10)}–${fmtInt(s.p90)}`; }, v => v)}</td>
        <td>${clubCalibration(c, results.provA)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function bindTable() {
  document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    tableSort = tableSort.key === k ? { key: k, dir: -tableSort.dir } : { key: k, dir: k === 'name' || k === 'actualRank' || k === 'medianRank' ? 1 : -1 };
    render();
  }));
  const f = $('#table-filter');
  if (f) {
    f.addEventListener('input', () => { tableFilter = f.value; render(); const g = $('#table-filter'); g.focus(); g.setSelectionRange(g.value.length, g.value.length); });
  }
}

// ------------------------------------------------------------------ titles

function editingSet() { return session.compare ? session.editing : 'a'; }

function seedLabel(t, e) {
  if (t.seedKind === 'cohort') return esc(e.cohort);
  if (typeof e.seed === 'number') return `#${e.seed}`;
  if (e.tier) return `${esc(e.tier)} tier`;
  return '<span class="muted">—</span>';
}

function viewTitles() {
  const setKey = editingSet();
  const t = DATA.titles.find(x => x.id === session.titleId) || DATA.titles[0];
  const ti = DATA.titles.indexOf(t);
  const ov = session.sets[setKey][t.id] || {};
  const cal = calibrateTitle(t, DATA.calibration, ov);
  const approved = DATA.calibration.approved[t.id];
  const tiers = curveTiers(t.pointsCurve, t.fieldSize);
  const isFlatMethod = t.seedKind === 'flat';
  const random = cal.method === 'random';
  const tviDisabled = random || isFlatMethod;
  const list = DATA.titles.map(x => {
    const mod = session.sets.a[x.id] || (session.compare && session.sets.b[x.id]);
    const st = DATA.calibration.approved[x.id] ? 'approved' : 'provisional';
    return `<li><button data-title="${x.id}" class="${x.id === t.id ? 'active' : ''}"><span>${esc(x.short)}${mod ? ' <span class="mod" title="Session override">●</span>' : ''}</span>
      <span class="tl-meta">${x.seedMethod} · ${st === 'approved' ? 'TVI ' + DATA.calibration.approved[x.id].tvi : 'prov.'}</span></button></li>`;
  }).join('');

  const opts = methodOptions(t).map(o => `<div class="method-option">
      <input type="radio" name="method" id="m-${o.id}" value="${o.id}" ${cal.method === o.id ? 'checked' : ''} />
      <label for="m-${o.id}">${o.id === 'established' ? `<b>${esc(o.label)}</b> <span class="muted">(workbook method ${esc(t.seedMethod)})</span>` : `<b>${esc(o.label)}</b>`}
        <small>${esc(o.note || '')}</small></label></div>`).join('');

  const tviDefault = approved ? approved.tvi : DATA.calibration.provisionalTvi;
  const tviInfo = `<div class="info">
      TVI is a temperature: <code>T = TVI / ${DATA.calibration.tviDivisor}</code>, and each entry's weight is <code>base^(1/T)</code>.
      A low TVI (T &lt; 1) sharpens the seeds so favourites win more often; a high TVI (T &gt; 1) flattens the field toward a lottery;
      TVI ${DATA.calibration.tviDivisor} leaves the base weights as they are. The effect is exponential: a top-to-bottom base span of <code>S</code> becomes <code>S^(1/T)</code>.
      <span class="live" id="tvi-live">${liveSpanText(cal.baseSpan, cal.tvi.tvi)}</span>
    </div>
    ${random ? `<p class="disabled-note">TVI is disabled: Random gives every entry the same weight, and raising equal weights to any power leaves them equal.</p>` : ''}
    ${isFlatMethod ? `<p class="disabled-note">This title's established method is E (no credible seed): every entry has equal weight, so TVI has no effect.</p>` : ''}`;

  const tierInputs = t.seedKind === 'cohort' && !random ? `<div class="card"><h4>Tier table (method D base weights)</h4>
      <div class="tvi-row">${Object.entries(t.tierTable).map(([k, v]) => {
        const cur = (ov.tierTable || t.tierTable)[k];
        return `<label class="ctl">${k} <input type="number" step="0.1" min="0.01" data-tier="${k}" value="${cur}" style="width:70px" />${modMarker(cur !== v, v)}</label>`;
      }).join('')}</div>
      <p class="muted" style="font-size:12px;margin-top:6px">Source: ${esc(t.tierTableSource)}. A tier weight is a relative strength — it doesn't change with how many teams are in the tier.</p></div>` : '';

  const res = results ? results[setKey] || results.a : null;
  const nT = tiers.length;
  const entryRows = t.entries.map((e, i) => {
    const actualTier = tierIndex(t.pointsCurve, e.placeFrom);
    const probs = res ? S.entryTiers(res, ti, i, nT) : null;
    const placeholder = DATA.placeholderClubs.includes(e.canonical);
    return `<tr><td>${esc(e.player || e.entrant)}${e.player && e.entrant && e.entrant !== e.player ? `<br><small class="muted">${esc(e.entrant)}</small>` : ''}</td>
      <td class="club">${placeholder ? `<span class="muted">${esc(e.canonical)}</span>` : `<a href="javascript:void 0" data-club="${esc(e.canonical)}">${esc(e.canonical)}</a>`}${e.void ? '<span class="badge void" title="Points voided (roster deadline): scores 0 wherever it finishes">void</span>' : ''}</td>
      <td class="num">${seedLabel(t, e)}</td><td class="num" title="${esc(cal.bases[i].from)}">${fmtW(cal.bases[i].base)}</td><td class="num">${fmtW(cal.weights[i])}</td>
      <td class="num">${esc(e.placement)}</td>
      ${tiers.map((tier, k) => `<td class="tier-cell ${k === actualTier ? 'actual' : ''}" ${k === actualTier ? 'title="Actual 2026 result"' : ''}>${probs ? fmtPct(probs[k]) : '…'}${probs ? `<span class="bar" style="width:${Math.round(probs[k] * 100)}%"></span>` : ''}</td>`).join('')}</tr>`;
  }).join('');

  return `<h2>Titles</h2><p class="lede">Session experiments per title. They change the weights sent to the engine for this browser session only; the defaults in data.json never change here (use Admin for that).
    ${session.compare ? `You are editing <b>parameter set ${setKey.toUpperCase()}</b>.` : ''}</p>
    <div class="titles-layout"><ul class="title-list">${list}</ul><div>
      <h3 style="margin-top:0">${esc(t.name)} ${tvBadge(cal)}</h3>
      <p class="muted" style="font-size:13px">${esc(t.format)} · ${t.fieldSize} entries · ${esc(t.placementGranularity || '')}</p>
      <div class="curve-chips">${tiers.map(x => `<span class="chip">${x.label} · ${fmtInt(x.points)}</span>`).join('')}</div>
      <div class="grid2" style="margin-top:12px">
        <div class="card"><h4>Seed method ${modMarker(random, t.seedMethodLabel)}</h4>${opts}
          <details class="rationale"><summary>Seed source and rationale (workbook)</summary>${[t.description, t.seedSectionTitle, ...(t.seedRationale || [])].filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}</details></div>
        <div class="card"><h4>TVI ${modMarker(cal.tvi.source === 'session', `${tviDefault} (${approved ? 'approved' : 'provisional'})`)}</h4>
          <div class="tvi-row">
            <input type="range" id="tvi-range" min="1" max="100" step="1" value="${cal.tvi.tvi}" ${tviDisabled ? 'disabled' : ''} />
            <input type="number" id="tvi-num" min="1" max="100" step="1" value="${cal.tvi.tvi}" ${tviDisabled ? 'disabled' : ''} />
            <button class="btn small" id="tvi-reset" ${cal.tvi.source === 'session' ? '' : 'disabled'}>Reset to ${tviDefault}</button>
          </div>
          <p style="font-size:12.5px;margin-top:6px">${approved ? `Approved TVI <b>${approved.tvi}</b>.` : `Not yet calibrated: provisional TVI <b>${DATA.calibration.provisionalTvi}</b>. The workbook tab proposes TVI ${t.workbookTvi} (not approved).`}</p>
          ${tviInfo}</div>
      </div>
      ${tierInputs}
      ${staleNote()}
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Entrant</th><th>Club</th><th class="num">Seed</th><th class="num" title="Base strength before temperature">Base</th><th class="num" title="Weight sent to the engine">Weight</th><th class="num">Actual</th>
        ${tiers.map(x => `<th class="num" title="${fmtInt(x.points)} pts">${x.label}<br>${fmtInt(x.points)}</th>`).join('')}</tr></thead>
        <tbody>${entryRows}</tbody></table></div>
      <p class="rule-note">Each cell is the probability of finishing in that points tier; the outlined cell is the actual 2026 result. Per-title expected points are deliberately not shown — they are not attainable outcomes.</p>
    </div></div>`;
}

function liveSpanText(baseSpan, tvi) {
  if (!(baseSpan > 1)) return 'All base weights are equal: effective span 1.00× at any TVI.';
  const T = tvi / DATA.calibration.tviDivisor;
  return `Top-to-bottom base span ${baseSpan.toFixed(2)}× → effective ${fmtSpan(spanAt(baseSpan, tvi, DATA.calibration.tviDivisor))} at TVI ${tvi} (T = ${T.toFixed(2)})`;
}
const fmtSpan = s => s >= 1e6 ? `${s.toExponential(2)}×` : `${s.toLocaleString('en-US', { maximumFractionDigits: s < 10 ? 2 : 0 })}×`;

function bindTitles() {
  const setKey = editingSet();
  const t = DATA.titles.find(x => x.id === session.titleId) || DATA.titles[0];
  document.querySelectorAll('[data-title]').forEach(b => b.addEventListener('click', () => update(s => ({ ...s, titleId: b.dataset.title }))));
  document.querySelectorAll('input[name=method]').forEach(r => r.addEventListener('change', () =>
    update(s => setOverride(DATA, s, setKey, t.id, { method: r.value === 'random' ? 'random' : undefined }), { rerun: true })));
  const range = $('#tvi-range'), num = $('#tvi-num');
  const cal = calibrateTitle(t, DATA.calibration, session.sets[setKey][t.id] || {});
  const commit = v => update(s => setOverride(DATA, s, setKey, t.id, { tvi: Math.min(100, Math.max(1, Math.round(v))) }), { rerun: true });
  if (range) {
    range.addEventListener('input', () => { num.value = range.value; $('#tvi-live').textContent = liveSpanText(cal.baseSpan, Number(range.value)); });
    range.addEventListener('change', () => commit(Number(range.value)));
    num.addEventListener('input', () => { if (num.value) $('#tvi-live').textContent = liveSpanText(cal.baseSpan, Math.min(100, Math.max(1, Number(num.value)))); });
    num.addEventListener('change', () => commit(Number(num.value)));
  }
  $('#tvi-reset')?.addEventListener('click', () => update(s => setOverride(DATA, s, setKey, t.id, { tvi: undefined }), { rerun: true }));
  document.querySelectorAll('input[data-tier]').forEach(inp => inp.addEventListener('change', () => {
    const cur = { ...((session.sets[setKey][t.id] || {}).tierTable || t.tierTable), [inp.dataset.tier]: Number(inp.value) };
    update(s => setOverride(DATA, s, setKey, t.id, { tierTable: cur }), { rerun: true });
  }));
}

// ------------------------------------------------------------------ club focus

function pickerHtml(id, label, value, allowClear) {
  return `<div class="picker"><label class="col-label" for="${id}">${label}</label><br>
    <input type="search" id="${id}" autocomplete="off" placeholder="Search clubs or aliases" value="${esc(value || '')}" />
    ${allowClear && value ? `<button class="btn small" data-clear="${id}">Clear</button>` : ''}
    <ul class="suggest hidden" id="${id}-list"></ul></div>`;
}

const BANDS = [
  { label: '1st', from: 0, to: 0 }, { label: '2nd–3rd', from: 1, to: 2 }, { label: '4th–8th', from: 3, to: 7 },
  { label: '9th–24th', from: 8, to: 23 }, { label: '25th or worse', from: 24, to: 24 },
];

function routeCell(route) {
  if (!route.runs) return '<td class="num">—</td><td></td>';
  const titles = route.titles.slice(0, 4).map(x => `<span>${esc(DATA.titles[x.title].short)} ${fmtPct(x.share)}</span>`).join('');
  return `<td class="num">${route.avgTitlesWon.toFixed(2)}</td><td class="route-titles">${titles || '<span class="muted">no title wins</span>'}</td>`;
}

function viewFocus() {
  const name = session.club && CLUB_INDEX.has(session.club) ? session.club : CLUBS[[...Array(CLUBS.length).keys()].find(c => ACTUAL.rank[c] === 1)];
  const c = CLUB_INDEX.get(name);
  const c2 = session.club2 && CLUB_INDEX.has(session.club2) && session.club2 !== name ? CLUB_INDEX.get(session.club2) : null;
  const head = `<h2>Club focus</h2><p class="lede">Every Club Championship placement for one club, read from the same simulation run as the tables — never a separate execution.</p>
    <div class="focus-pickers">${pickerHtml('pick-club', 'Club', name, false)}${pickerHtml('pick-club2', 'Overlay a second club', c2 != null ? CLUBS[c2] : '', true)}</div>`;
  if (!results) return head + waitingMsg();
  const res = results.a, B = res.buckets;
  const actualBucket = cc => Math.min(ACTUAL.rank[cc], B) - 1;
  const series = [{ label: `${name}${results.b ? ' (A)' : ''}`, color: '#ff5900', probs: S.placementBuckets(res, c).map(b => b.p), actualBucket: actualBucket(c) }];
  if (results.b) series.push({ label: `${name} (B)`, color: '#2f4b7c', probs: S.placementBuckets(results.b, c).map(b => b.p), actualBucket: actualBucket(c), noMarker: true });
  if (c2 != null) series.push({ label: CLUBS[c2], color: '#15171a', outline: true, probs: S.placementBuckets(res, c2).map(b => b.p), actualBucket: actualBucket(c2) });
  const labels = S.placementBuckets(res, c).map((b, i) => i === B - 1 ? `${B}+` : String(i + 1));

  const cols = [{ label: `${name}${results.b ? ' · A' : ''}`, res, c }];
  if (results.b) cols.push({ label: `${name} · B`, res: results.b, c, b: true });
  if (c2 != null) cols.push({ label: CLUBS[c2], res, c: c2 });
  const sums = cols.map(col => S.clubSummary(col.res, col.c, ACTUAL));
  const statRow = (label, fn, cls = '') => `<tr class="${cls}"><td>${label}</td>${sums.map((s, i) => `<td class="num" ${cols[i].b ? 'style="color:var(--b-series)"' : ''}>${fn(s, cols[i])}</td>`).join('')}</tr>`;
  const stats = `<div class="table-scroll"><table class="data" style="max-width:760px">
    <thead><tr><th></th>${cols.map(col => `<th class="num">${esc(col.label)}</th>`).join('')}</tr></thead><tbody>
    ${statRow('Actual 2026', (s, col) => `${actualRankLabel(col.c)} · ${fmtInt(s.actualPoints)} pts`, 'highlight')}
    ${statRow('P(exact actual placement)', s => fmtPct(s.pExactActual))}
    ${statRow('Median rank', s => fmtInt(s.medianRank))}
    ${statRow('P(win)', s => fmtPct(s.pWin))}
    ${statRow('P(top 3)', s => fmtPct(s.pTop3))}
    ${statRow('P(top 8)', s => fmtPct(s.pTop8))}
    ${statRow(`P(top ${B - 1})`, s => fmtPct(s.pTop24))}
    ${statRow('Mean points', s => fmtInt(s.meanPoints))}
    ${statRow('Median points', s => fmtInt(s.medianPoints))}
    ${statRow('P10 – P90 points', s => `${fmtInt(s.p10)} – ${fmtInt(s.p90)}`)}
    ${statRow('P(eligible: 2+ top-8s)', s => fmtPct(s.pEligible))}
    ${statRow('Titles entered', (s, col) => `${CLUB_TITLES[col.c].length} ${clubCalibration(col.c, col.b ? results.provB : results.provA)}`)}
    </tbody></table></div>`;

  const buckets = S.placementBuckets(res, c);
  let cum = 0;
  const placeRows = buckets.map((b, i) => {
    cum += b.p;
    const route = S.routeFor(res, c, i, i);
    const isActual = i === actualBucket(c);
    return `<tr class="${isActual ? 'highlight' : ''}"><td class="rank">${b.outside ? `${B}th or worse <small class="muted">outside paying bracket</small>` : ordinal(i + 1)}${isActual ? ' <span class="badge provisional" title="Actual 2026 placement">actual</span>' : ''}</td>
      <td class="num">${fmtPct(b.p)}</td>${results.b ? `<td class="num" style="color:var(--b-series)">${fmtPct(S.placementBuckets(results.b, c)[i].p)}</td>` : ''}<td class="num">${fmtPct(Math.min(1, cum))}</td>${routeCell(route)}</tr>`;
  }).join('');
  const bandRows = BANDS.map(band => {
    const route = S.routeFor(res, c, band.from, band.to);
    return `<tr><td>${band.label}</td><td class="num">${fmtPct(route.p)}</td>${routeCell(route)}</tr>`;
  }).join('');

  return head + staleNote() + stats +
    `<h3>Placement distribution</h3><div class="chart">${placementChart({ series, labels, outsideIndex: B - 1 })}
      <div class="legend">${series.map(s => `<span><i style="background:${s.outline ? 'transparent' : s.color};border:1.5px solid ${s.color}"></i>${esc(s.label)}${s.noMarker ? '' : ` — actual ${actualRankLabel(s === series[0] ? c : c2)}`}</span>`).join('')}</div></div>
    <h3>Every placement, and the route to it</h3>
    <p class="rule-note">For each placement: how often it happened, and in those runs the average number of titles ${esc(name)} won and which titles most often produced those wins (share of runs at that placement in which the title was won).</p>
    <div class="table-scroll"><table class="data"><thead><tr><th>Placement</th><th class="num">P</th>${results.b ? '<th class="num">P (B)</th>' : ''}<th class="num">Cumulative</th><th class="num">Avg titles won</th><th>Titles won most often</th></tr></thead><tbody>${placeRows}</tbody></table></div>
    <h3>By band</h3><div class="table-scroll"><table class="data" style="max-width:900px"><thead><tr><th>Band</th><th class="num">P</th><th class="num">Avg titles won</th><th>Titles won most often</th></tr></thead><tbody>${bandRows}</tbody></table></div>
    ${contributionPanel(c)}`;
}

function contributionPanel(c) {
  const res = results.a;
  const rows = CLUB_TITLES[c].map(ti => ({ ti, contrib: res.clubTitlePointsSum[c * res.nTitles + ti] }))
    .sort((a, b) => b.contrib - a.contrib || a.ti - b.ti);
  const name = CLUBS[c];
  const body = rows.map(({ ti }) => {
    const t = DATA.titles[ti];
    const tiers = curveTiers(t.pointsCurve, t.fieldSize);
    const probs = S.clubTitleTiers(res, c, ti, tiers.length);
    const actualPts = ACTUAL.titlePts[c * res.nTitles + ti];
    const actualTier = MODEL0.titles[ti].tierOfPoints.get(actualPts);
    const cal = results.provA[t.id];
    const entries = t.entries.map((e, i) => ({ e, i })).filter(x => x.e.canonical === name);
    const bar = probs.map((p, k) => p > 0 ? `<div class="${tiers[k].points === 0 ? 'tzero' : k < 4 ? 't' + k : 'tmid'}" style="width:${(p * 100).toFixed(2)}%" title="${tiers[k].label} (${fmtInt(tiers[k].points)} pts): ${fmtPct(p)}"></div>` : '').join('');
    const list = probs.map((p, k) => `<span class="${k === actualTier ? 'act' : ''}">${tiers[k].label} <b>${fmtPct(p)}</b></span>`).join(' · ');
    return `<tr><td><b>${esc(t.short)}</b><br><small class="muted">${esc(t.name)}</small><br>${tvBadge(cal)}</td>
      <td>${entries.map(({ e, i }) => `${esc(e.player || e.entrant)} <span class="muted">(${seedLabel(t, e)}${t.seedKind === 'cohort' ? '' : ''}, weight ${fmtW(cal.weights[i])})</span>${e.void ? '<span class="badge void">void</span>' : ''}`).join('<br>')}
        ${entries.length > 1 ? '<br><small class="muted">Only the best-placed entry scores.</small>' : ''}</td>
      <td><div class="tierbar">${bar}</div><div class="tier-list">${list}</div></td>
      <td class="num">${fmtInt(actualPts)}<br><small class="muted">${tiers[actualTier]?.label || ''}</small></td></tr>`;
  }).join('');
  return `<h3>Per-title contribution</h3>
    <p class="rule-note">${esc(name)}'s entries in all ${rows.length} titles it entered. Each bar is the distribution of the club's scored result over that title's attainable tiers (actual 2026 tier underlined). Sorted by simulated contribution; per-title expected points are not shown because they are not attainable outcomes.</p>
    <div class="table-scroll"><table class="data"><thead><tr><th>Title</th><th>Entries (seed, weight)</th><th>Scored result — probability by tier</th><th class="num">Actual pts</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function bindFocus() {
  const wire = (id, key) => {
    const input = $(`#${id}`), list = $(`#${id}-list`);
    if (!input) return;
    let active = 0, matches = [];
    const show = () => {
      const q = input.value.trim().toLowerCase();
      matches = SEARCH.filter(s => !q || s.hay.some(h => h.includes(q)))
        .sort((a, b) => (b.name.toLowerCase().startsWith(q)) - (a.name.toLowerCase().startsWith(q)) || ACTUAL.rank[a.c] - ACTUAL.rank[b.c])
        .slice(0, 30);
      active = 0;
      list.innerHTML = matches.map((m, i) => {
        const via = q && !m.name.toLowerCase().includes(q) ? m.alt.find(a => a.toLowerCase().includes(q)) : null;
        return `<li data-i="${i}" class="${i === 0 ? 'active' : ''}">${esc(m.name)}${via ? `<small>via “${esc(via)}”</small>` : ''}</li>`;
      }).join('');
      list.classList.toggle('hidden', !matches.length);
    };
    const choose = m => update(s => ({ ...s, [key]: m.name }));
    input.addEventListener('focus', () => { input.select(); show(); });
    input.addEventListener('input', show);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(matches.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === active));
      } else if (e.key === 'Enter' && matches[active]) choose(matches[active]);
      else if (e.key === 'Escape') list.classList.add('hidden');
    });
    list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) choose(matches[Number(li.dataset.i)]); });
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
  };
  wire('pick-club', 'club');
  wire('pick-club2', 'club2');
  document.querySelector('[data-clear="pick-club2"]')?.addEventListener('click', () => update(s => ({ ...s, club2: null })));
}

// ------------------------------------------------------------------ investment

function viewInvestment() {
  const head = `<h2>Investment layer</h2><p class="lede">Optional post-processing over the simulation output. Spend figures are estimates; every derived number carries its confidence label. The simulator works fully without this table.</p>`;
  if (!(DATA.investment || []).length) return head + '<p class="muted">No investment data in data.json yet. Add rows in the admin panel and commit the exported file.</p>';
  if (!results) return head + waitingMsg();
  const rows = investmentMetrics(DATA, results.a, ACTUAL, CLUB_INDEX);
  const money = (n, cur) => n == null ? '—' : `${esc(cur)} ${Math.round(n).toLocaleString('en-US')}`;
  const conf = r => `<span class="badge conf-${esc(r.inv.confidence)}" title="Confidence of the spend estimate">${esc(r.inv.confidence)}</span>`;
  return head + staleNote() + `<div class="table-scroll"><table class="data"><thead><tr>
      <th>Club</th><th class="num">Est. annual spend</th><th>Source</th><th class="num">Titles</th><th class="num">Actual pts</th>
      <th class="num">Cost / pt (actual)</th><th class="num">Cost / pt simulated<br>P10 · median · P90</th><th class="num">Runs with 0 pts</th>
      <th class="num">Pts / title<br>actual · sim mean</th><th class="num">Pts per 1M<br>actual · sim mean</th><th class="num">Actual ÷ sim mean</th></tr></thead><tbody>
    ${rows.map(r => r.missing ? `<tr><td>${esc(r.club)}</td><td colspan="10" class="muted">No entries in the simulation.</td></tr>` : `<tr class="clickable" data-club="${esc(r.club)}">
      <td class="club">${esc(r.club)}</td><td class="num">${money(r.inv.annualSpend, r.inv.currency)} ${conf(r)}</td><td><small>${esc(r.inv.source || '')}</small></td>
      <td class="num">${r.titlesEntered}</td><td class="num">${fmtInt(r.actualPoints)}</td>
      <td class="num">${money(r.costPerPointActual, r.inv.currency)} ${conf(r)}</td>
      <td class="num">${r.costPerPointSim.median == null ? '—' : `${money(r.costPerPointSim.p10, r.inv.currency)} · ${money(r.costPerPointSim.median, r.inv.currency)} · ${money(r.costPerPointSim.p90, r.inv.currency)}`} ${conf(r)}</td>
      <td class="num">${fmtPct(r.costPerPointSim.zeroShare)}</td>
      <td class="num">${r.pointsPerTitleActual?.toFixed(0) ?? '—'} · ${r.pointsPerTitleSimMean?.toFixed(0) ?? '—'}</td>
      <td class="num">${(r.pointsPerUnitActual * 1e6).toFixed(1)} · ${(r.pointsPerUnitSimMean * 1e6).toFixed(1)} ${conf(r)}</td>
      <td class="num">${r.actualVsSim == null ? '—' : r.actualVsSim.toFixed(2) + '×'} ${conf(r)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="rule-note">Currencies are not converted; "per 1M" is in each row's own currency. Simulated cost per point excludes runs where the club scored nothing (shown separately).</p>`;
}

// ------------------------------------------------------------------ method

function viewMethod() {
  const cal = DATA.calibration;
  return `<h2>Method</h2>
    <div class="grid2">
    <div class="card"><h4>Engine</h4><p style="font-size:13.5px">For each run and title, a full finishing order is drawn by <b>Plackett-Luce</b>: 1st is picked with probability proportional to weight, removed, then 2nd from the rest, and so on (implemented with the equivalent Gumbel-max trick). Positions score on the title's points curve; voided entries score 0 wherever they finish; each club keeps its <b>best entry per title</b> and sums across titles. The engine receives finished weights and contains no seed or TVI logic.</p></div>
    <div class="card"><h4>Calibration (upstream of the engine)</h4><p style="font-size:13.5px"><code>${esc(cal.rule)}</code><br>TVI is the title's approved value where calibrated, otherwise the provisional placeholder <b>${cal.provisionalTvi}</b>. Titles can also be switched to Random (equal weights) per session.</p></div>
    <div class="card"><h4>Ranking & ties</h4><p style="font-size:13.5px">${esc(DATA.ccRules.tieRule)}</p><p style="font-size:13px;margin-top:6px" class="muted">${esc(DATA.ccRules.bestResultOnly)} <a href="${esc(DATA.ccRules.source)}" target="_blank" rel="noopener">Source</a>.</p></div>
    <div class="card"><h4>Presentation</h4><p style="font-size:13.5px">Per-title results are shown only as probabilities over <b>attainable tiers</b> (e.g. 1000 / 750 / 500 / 300 / 200 / 0), never as an expected-points figure no team can score. Club totals are sums across titles, so means and percentiles are shown for those.</p></div>
    </div>
    <h3>Calibration status by title</h3>
    <div class="table-scroll"><table class="data"><thead><tr><th>Title</th><th>Workbook method</th><th>Seed source</th><th class="num">Workbook TVI</th><th class="num">TVI used</th><th>Status</th></tr></thead><tbody>
    ${DATA.titles.map(t => { const a = cal.approved[t.id]; return `<tr><td>${esc(t.name)}</td><td>${esc(t.seedMethodLabel)}</td><td><small>${esc(t.seedSource || '')}</small></td><td class="num">${t.workbookTvi}</td><td class="num">${a ? a.tvi : cal.provisionalTvi}</td><td>${a ? '<span class="badge approved">approved</span>' : '<span class="badge provisional">not yet calibrated</span>'}</td></tr>`; }).join('')}
    </tbody></table></div>
    <h3>Data</h3><p class="lede">All defaults come from <code>${esc(DATA.source.workbook)}</code> (sha256 ${esc(DATA.source.sha256.slice(0, 16))}…), extracted to data.json. Substituting actual placements for the draw reproduces all ${DATA.reconciliation.length} official Club Championship totals exactly. HavoK by Vitality and Ekletyc score on their title tabs but do not appear in the official standings; they are simulated as normal clubs.</p>`;
}

boot().catch(err => {
  $('#panel').innerHTML = `<p class="state-msg error" style="color:#c0392b">Failed to load: ${esc(err.message)}</p>`;
  console.error(err);
});
