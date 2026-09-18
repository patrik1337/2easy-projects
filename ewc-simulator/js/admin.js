// Admin: edits a working copy of data.json defaults and exports a complete file.
// Nothing here touches simulator session state.
import { validateData, diffJson, describePath } from './validate.js';
import { parsePlacement } from './engine.js';

// SHA-256 of the admin password. To change it:
//   python -c "import hashlib;print(hashlib.sha256(b'NEW-PASSWORD').hexdigest())"
const PASSWORD_SHA256 = '5bbd8da6b844d3274040dee3cbf8e3054194ceb6bab74801756f2f20023b1423';
const DRAFT_KEY = 'ewc-admin-draft-v1';
const KIND_BY_METHOD = { A: 'ranked', B: 'ranked', C: 'ranked', D: 'cohort', E: 'flat' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let committed, work, tab = 'titles', titleId = null;

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

$('#gate-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (await sha256($('#gate-pw').value) !== PASSWORD_SHA256) { $('#gate-msg').textContent = 'Wrong password.'; return; }
  sessionStorage.setItem('ewc-admin', '1');
  unlock();
});
if (sessionStorage.getItem('ewc-admin') === '1') unlock();

async function unlock() {
  $('#gate').classList.add('hidden');
  $('#admin').classList.remove('hidden');
  committed = await (await fetch('data.json', { cache: 'no-cache' })).json();
  Object.freeze(committed);
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* no draft */ }
  if (draft && draft.base === committed.source.sha256 && draft.work) {
    work = draft.work;
  } else {
    work = structuredClone(committed);
  }
  titleId = work.titles[0].id;
  $('#admin-nav').addEventListener('click', ev => { if (ev.target.dataset.tab) { tab = ev.target.dataset.tab; render(); } });
  render();
}

function saveDraft() {
  const changes = diffJson(committed, work).length;
  try {
    if (changes) localStorage.setItem(DRAFT_KEY, JSON.stringify({ base: committed.source.sha256, work }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* storage unavailable: the working copy still lives in memory */ }
  $('#draft-status').innerHTML = changes
    ? `<b>${changes}</b> unexported change${changes > 1 ? 's' : ''} (draft kept in this browser). <button class="btn small" id="discard">Discard draft</button>`
    : 'No changes from the committed file.';
  $('#discard')?.addEventListener('click', () => {
    if (!confirm('Discard every admin change and reload the committed data.json?')) return;
    work = structuredClone(committed);
    saveDraft(); render();
  });
}

function render() {
  document.querySelectorAll('#admin-nav .section-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const views = { titles: viewTitles, clubs: viewClubs, investment: viewInvestment, export: viewExport };
  $('#admin-panel').innerHTML = views[tab]();
  ({ titles: bindTitles, clubs: bindClubs, investment: bindInvestment, export: bindExport })[tab]();
  saveDraft();
}

// Generic binding: inputs carry data-path="titles.3.entries.4.seed" and data-type.
function bindPaths(root, after) {
  root.querySelectorAll('[data-path]').forEach(el => el.addEventListener('change', () => {
    const path = el.dataset.path.split('.');
    let v = el.type === 'checkbox' ? el.checked : el.value;
    const type = el.dataset.type;
    if (type === 'number') v = el.value === '' ? null : Number(el.value);
    if (type === 'int') v = el.value === '' ? null : Math.round(Number(el.value));
    if (type === 'text-or-null') v = el.value.trim() || null;
    let obj = work;
    for (const k of path.slice(0, -1)) obj = obj[k];
    obj[path.at(-1)] = v;
    if (after) after(path, v, el);
    render();
  }));
}

// ------------------------------------------------------------------ titles

function viewTitles() {
  const ti = work.titles.findIndex(t => t.id === titleId);
  const t = work.titles[ti];
  const approved = work.calibration.approved[t.id];
  const names = work.clubs.map(c => c.name).concat(work.placeholderClubs);
  const p = `titles.${ti}`;
  return `<div class="ctl" style="margin-bottom:12px">Title <select id="title-pick">${work.titles.map(x => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.short)} — ${esc(x.name)}</option>`).join('')}</select></div>
    <datalist id="club-names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="grid2">
      <div class="card"><h4>Calibration</h4>
        <label class="ctl"><input type="checkbox" id="cal-approved" ${approved ? 'checked' : ''} /> TVI approved (title calibrated)</label>
        <div class="tvi-row" style="margin-top:8px"><label class="ctl">Approved TVI <input type="number" id="cal-tvi" min="1" max="100" step="1" value="${approved ? approved.tvi : t.workbookTvi}" ${approved ? '' : 'disabled'} /></label>
          <span class="muted" style="font-size:12px">Workbook tab TVI: ${t.workbookTvi}. Uncalibrated titles run on TVI ${work.calibration.provisionalTvi}.</span></div>
        <label class="ctl" style="margin-top:8px;display:block">Note <input type="text" id="cal-note" value="${esc(approved?.note || '')}" ${approved ? '' : 'disabled'} style="width:100%" /></label>
      </div>
      <div class="card"><h4>Seed method</h4>
        <label class="ctl">Method <select data-path="${p}.seedMethod" id="seed-method">${['A', 'B', 'C', 'D', 'E'].map(m => `<option ${m === t.seedMethod ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="ctl" style="margin-top:6px;display:block">Label <input type="text" data-path="${p}.seedMethodLabel" value="${esc(t.seedMethodLabel)}" style="width:100%" /></label>
        <label class="ctl" style="margin-top:6px;display:block">Source <input type="text" data-path="${p}.seedSource" value="${esc(t.seedSource)}" style="width:100%" /></label>
        ${t.seedKind === 'cohort' ? `<div class="tvi-row" style="margin-top:8px">${Object.entries(t.tierTable || {}).map(([k, v]) => `<label class="ctl">${k} <input type="number" step="0.1" data-type="number" data-path="${p}.tierTable.${k}" value="${v}" style="width:70px" /></label>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="card"><h4>Points curve</h4>
      <table class="data edit" style="max-width:520px"><thead><tr><th class="num">From place</th><th class="num">Points</th><th>Band label</th><th></th></tr></thead><tbody>
      ${t.pointsCurve.map((b, i) => `<tr><td class="num"><input type="number" data-type="int" data-path="${p}.pointsCurve.${i}.from" value="${b.from}" /></td>
        <td class="num"><input type="number" data-type="int" data-path="${p}.pointsCurve.${i}.points" value="${b.points}" /></td>
        <td><input type="text" data-type="text-or-null" data-path="${p}.pointsCurve.${i}.band" value="${esc(b.band || '')}" /></td>
        <td><button class="btn small" data-del-band="${i}">✕</button></td></tr>`).join('')}
      </tbody></table><button class="btn small" id="add-band" style="margin-top:6px">Add band</button></div>
    <div class="card"><h4>Entries (${t.entries.length}; field size <input type="number" data-type="int" data-path="${p}.fieldSize" value="${t.fieldSize}" style="width:60px" />)</h4>
      <div class="table-scroll"><table class="data edit"><thead><tr><th>Entrant</th><th>Player</th><th>Canonical club</th><th class="num">Seed</th><th>Cohort</th><th>Tier</th><th>Placement</th><th>Void</th><th></th></tr></thead><tbody>
      ${t.entries.map((e, i) => {
        const q = `${p}.entries.${i}`;
        return `<tr><td><input type="text" data-path="${q}.entrant" value="${esc(e.entrant)}" /></td>
          <td><input type="text" data-type="text-or-null" data-path="${q}.player" value="${esc(e.player || '')}" /></td>
          <td><input type="text" list="club-names" data-path="${q}.canonical" value="${esc(e.canonical)}" /></td>
          <td class="num"><input type="number" data-type="number" data-path="${q}.seed" value="${e.seed ?? ''}" /></td>
          <td><select data-type="text-or-null" data-path="${q}.cohort"><option value="">—</option>${['High', 'Medium', 'Low'].map(c => `<option ${c === e.cohort ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
          <td><input type="text" data-type="text-or-null" data-path="${q}.tier" value="${esc(e.tier || '')}" style="min-width:70px" /></td>
          <td><input type="text" data-path="${q}.placement" data-placement="${i}" value="${esc(e.placement)}" style="min-width:70px" /></td>
          <td><input type="checkbox" data-path="${q}.void" ${e.void ? 'checked' : ''} /></td>
          <td><button class="btn small" data-del-entry="${i}">✕</button></td></tr>`;
      }).join('')}
      </tbody></table></div><button class="btn small" id="add-entry" style="margin-top:6px">Add entry</button></div>`;
}

function bindTitles() {
  const t = work.titles.find(x => x.id === titleId);
  $('#title-pick').addEventListener('change', e => { titleId = e.target.value; render(); });
  $('#cal-approved').addEventListener('change', e => {
    if (e.target.checked) work.calibration.approved[t.id] = { tvi: t.workbookTvi, note: '' };
    else delete work.calibration.approved[t.id];
    render();
  });
  $('#cal-tvi').addEventListener('change', e => { work.calibration.approved[t.id].tvi = Math.round(Number(e.target.value)); render(); });
  $('#cal-note').addEventListener('change', e => { work.calibration.approved[t.id].note = e.target.value; render(); });
  bindPaths($('#admin-panel'), (path, v, el) => {
    if (path.at(-1) === 'seedMethod') {
      t.seedKind = KIND_BY_METHOD[v];
      if (t.seedKind === 'cohort' && !t.tierTable) { t.tierTable = { ...work.calibration.defaultTierTable }; t.tierTableSource = 'default'; }
    }
    if (el.dataset.placement !== undefined) {
      const e = t.entries[Number(el.dataset.placement)];
      try { const pl = parsePlacement(v); e.placeFrom = pl.from; e.placeTo = pl.to; e.placement = pl.from === pl.to ? String(pl.from) : `${pl.from}-${pl.to}`; } catch { /* validation reports it */ }
    }
  });
  document.querySelectorAll('[data-del-band]').forEach(b => b.addEventListener('click', () => { t.pointsCurve.splice(Number(b.dataset.delBand), 1); render(); }));
  $('#add-band').addEventListener('click', () => { const last = t.pointsCurve.at(-1); t.pointsCurve.push({ from: (last?.from || 0) + 1, points: 0, band: null }); render(); });
  document.querySelectorAll('[data-del-entry]').forEach(b => b.addEventListener('click', () => {
    const e = t.entries[Number(b.dataset.delEntry)];
    if (confirm(`Remove ${e.player || e.entrant} from ${t.short}?`)) { t.entries.splice(Number(b.dataset.delEntry), 1); render(); }
  }));
  $('#add-entry').addEventListener('click', () => {
    t.entries.push({ row: null, entrant: 'New entry', player: null, canonical: '', seed: null, cohort: null, tier: null,
      placement: String(t.entries.length + 1), placeFrom: t.entries.length + 1, placeTo: t.entries.length + 1,
      sheetPoints: null, officialPoints: null, void: false, notes: null, id: `${t.id}:${t.entries.length}` });
    render();
  });
}

// ------------------------------------------------------------------ clubs

function viewClubs() {
  return `<p class="lede">The club registry. Canonical names in title entries must match a registry name (or a placeholder). Aliases feed the simulator's club search.</p>
    <div class="table-scroll"><table class="data edit"><thead><tr><th>Id</th><th>Display name</th><th>Aliases (semicolon separated)</th><th>Source</th><th class="num">Entries</th></tr></thead><tbody>
    ${work.clubs.map((c, i) => {
      const n = work.titles.reduce((s, t) => s + t.entries.filter(e => e.canonical === c.name).length, 0);
      return `<tr><td><input type="text" data-path="clubs.${i}.id" value="${esc(c.id)}" /></td>
        <td><input type="text" data-rename="${i}" value="${esc(c.name)}" /></td>
        <td><input type="text" data-aliases="${i}" value="${esc((c.aliases || []).join('; '))}" style="min-width:320px" /></td>
        <td class="muted">${esc(c.source)}</td><td class="num">${n}</td></tr>`;
    }).join('')}
    </tbody></table></div><button class="btn small" id="add-club" style="margin-top:8px">Add club</button>`;
}

function bindClubs() {
  bindPaths($('#admin-panel'));
  document.querySelectorAll('[data-aliases]').forEach(el => el.addEventListener('change', () => {
    work.clubs[Number(el.dataset.aliases)].aliases = el.value.split(';').map(s => s.trim()).filter(Boolean);
    render();
  }));
  document.querySelectorAll('[data-rename]').forEach(el => el.addEventListener('change', () => {
    const club = work.clubs[Number(el.dataset.rename)];
    const from = club.name, to = el.value.trim();
    if (!to || to === from) return render();
    const refs = work.titles.reduce((s, t) => s + t.entries.filter(e => e.canonical === from).length, 0)
      + work.reconciliation.filter(r => r.club === from).length + (work.investment || []).filter(r => r.club === from).length;
    club.name = to;
    if (refs && confirm(`Also rename '${from}' to '${to}' in ${refs} entries, reconciliation and investment rows? (Cancel leaves them as orphans, which export will refuse.)`)) {
      for (const t of work.titles) for (const e of t.entries) if (e.canonical === from) e.canonical = to;
      for (const r of work.reconciliation) if (r.club === from) r.club = to;
      for (const r of work.investment || []) if (r.club === from) r.club = to;
    }
    render();
  }));
  $('#add-club').addEventListener('click', () => {
    work.clubs.push({ id: `club_${work.clubs.length + 1}`, name: `New club ${work.clubs.length + 1}`, aliases: [], source: 'admin', entrantNames: [] });
    render();
  });
}

// ------------------------------------------------------------------ investment

function viewInvestment() {
  const rows = work.investment || [];
  return `<p class="lede">Estimated annual spend or roster cost per club. Every figure is an estimate; confidence is required and is shown wherever a derived number appears. Optional: the simulator works without any rows.</p>
    <datalist id="club-names">${work.clubs.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
    <div class="table-scroll"><table class="data edit"><thead><tr><th>Club</th><th class="num">Annual spend</th><th>Currency</th><th>Confidence</th><th>Source</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td><input type="text" list="club-names" data-path="investment.${i}.club" value="${esc(r.club)}" /></td>
      <td class="num"><input type="number" data-type="number" data-path="investment.${i}.annualSpend" value="${r.annualSpend ?? ''}" style="width:130px" /></td>
      <td><input type="text" data-path="investment.${i}.currency" value="${esc(r.currency)}" style="min-width:60px;width:70px" /></td>
      <td><select data-path="investment.${i}.confidence">${['high', 'medium', 'low', 'estimate'].map(c => `<option ${c === r.confidence ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
      <td><input type="text" data-path="investment.${i}.source" value="${esc(r.source)}" style="min-width:260px" /></td>
      <td><button class="btn small" data-del-inv="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No rows.</td></tr>'}
    </tbody></table></div><button class="btn small" id="add-inv" style="margin-top:8px">Add row</button>`;
}

function bindInvestment() {
  if (!work.investment) work.investment = [];
  bindPaths($('#admin-panel'));
  document.querySelectorAll('[data-del-inv]').forEach(b => b.addEventListener('click', () => { work.investment.splice(Number(b.dataset.delInv), 1); render(); }));
  $('#add-inv').addEventListener('click', () => { work.investment.push({ club: '', annualSpend: null, currency: 'USD', confidence: 'estimate', source: '' }); render(); });
}

// ------------------------------------------------------------------ export

function viewExport() {
  const v = validateData(work);
  const diff = diffJson(committed, work);
  const show = x => x === undefined ? '∅' : esc(JSON.stringify(x)).slice(0, 160);
  return `<div class="grid2">
    <div class="card"><h4>Validation</h4>
      ${v.ok ? `<p class="ok-msg">All checks pass. ${v.reconciled} of ${v.reconciliationRows} clubs reconcile to their official CC total.</p>`
        : `<p style="color:var(--down);font-weight:500">Export refused — ${v.errors.length} problem${v.errors.length > 1 ? 's' : ''}:</p><ul class="error-list">${v.errors.slice(0, 200).map(e => `<li><b>${esc(e.area)}</b>: ${esc(e.msg)}</li>`).join('')}</ul>`}
      <p class="muted" style="font-size:12.5px;margin-top:8px">Checks: every club reconciles to its official CC total using actual placements; no orphaned canonical names; every entry has a seed its method can use; curves, tier tables, TVIs and investment rows are well-formed.</p>
    </div>
    <div class="card"><h4>Diff against committed data.json (${diff.length})</h4>
      ${diff.length ? `<div class="diff-list">${diff.map(d => `<div><b>${esc(describePath(work, d.path))}</b> <span class="muted">${esc(d.path)}</span><br><del>${show(d.before)}</del> → <ins>${show(d.after)}</ins></div>`).join('')}</div>` : '<p class="muted">No changes.</p>'}
    </div></div>
    <button class="btn primary" id="export" ${v.ok && diff.length ? '' : 'disabled'}>Export data.json</button>
    <button class="btn" id="copy" ${v.ok && diff.length ? '' : 'disabled'}>Copy JSON</button>
    <p class="rule-note">After exporting, replace <code>ewc-simulator/data.json</code> and commit. Re-running the workbook extractor keeps calibration approvals and investment rows but regenerates everything else from the workbook, so mirror structural edits (entries, seeds, curves, clubs) into the workbook too.</p>`;
}

function exportText() { return JSON.stringify(work, null, 1) + '\n'; }

function bindExport() {
  $('#export')?.addEventListener('click', () => {
    if (!validateData(work).ok) return render();
    const url = URL.createObjectURL(new Blob([exportText()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'data.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#copy')?.addEventListener('click', async () => {
    if (!validateData(work).ok) return render();
    await navigator.clipboard.writeText(exportText());
    $('#copy').textContent = 'Copied';
  });
}
