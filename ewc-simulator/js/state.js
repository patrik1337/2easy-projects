// Session state: experiments layered over the immutable defaults in data.json.
// Only differences from defaults are stored, and the whole state round-trips
// through the URL hash so a configuration is shareable as a link.

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export function defaultSession(data) {
  return {
    runs: data.simulationDefaults.runs,
    seed: data.simulationDefaults.rngSeed,
    view: 'summary',
    club: null,
    club2: null,
    titleId: data.titles[0].id,
    compare: false,
    editing: 'a',
    sets: { a: {}, b: {} },   // per parameter set: { [titleId]: { method?, tvi?, tierTable? } }
  };
}

/** Drop overrides that equal the default so "modified" markers and URLs stay honest. */
export function normaliseOverride(data, titleId, ov) {
  const t = data.titles.find(x => x.id === titleId);
  if (!t || !ov) return null;
  const out = {};
  if (ov.method === 'random') out.method = 'random';
  const approved = data.calibration.approved[titleId];
  const defTvi = approved ? approved.tvi : data.calibration.provisionalTvi;
  if (Number.isFinite(ov.tvi) && ov.tvi !== defTvi) out.tvi = Math.min(100, Math.max(1, Math.round(ov.tvi)));
  if (ov.tierTable && t.tierTable) {
    const tt = {};
    for (const [k, v] of Object.entries(ov.tierTable)) if (Number.isFinite(v) && v > 0 && v !== t.tierTable[k]) tt[k] = v;
    if (Object.keys(tt).length) out.tierTable = { ...t.tierTable, ...tt };
  }
  return Object.keys(out).length ? out : null;
}

export function setOverride(data, session, setKey, titleId, patch) {
  const current = session.sets[setKey][titleId] || {};
  const next = normaliseOverride(data, titleId, { ...current, ...patch });
  const sets = { ...session.sets, [setKey]: { ...session.sets[setKey] } };
  if (next) sets[setKey][titleId] = next; else delete sets[setKey][titleId];
  return { ...session, sets };
}

const b64 = {
  enc: s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
};

export function encodeSession(data, session) {
  const def = defaultSession(data);
  const o = {};
  for (const k of ['runs', 'seed', 'view', 'club', 'club2', 'titleId', 'compare']) if (session[k] !== def[k]) o[k] = session[k];
  if (Object.keys(session.sets.a).length) o.a = session.sets.a;
  if (session.compare && Object.keys(session.sets.b).length) o.b = session.sets.b;
  return Object.keys(o).length ? 's=' + b64.enc(JSON.stringify(o)) : '';
}

export function decodeSession(data, hash) {
  const s = defaultSession(data);
  const m = /(?:^#?|&)s=([^&]+)/.exec(hash || '');
  if (!m) return s;
  let o;
  try { o = JSON.parse(b64.dec(m[1])); } catch { return s; }
  if (Number.isInteger(o.runs) && o.runs >= 100 && o.runs <= 500000) s.runs = o.runs;
  if (Number.isInteger(o.seed)) s.seed = o.seed;
  if (typeof o.view === 'string') s.view = o.view;
  if (typeof o.club === 'string') s.club = o.club;
  if (typeof o.club2 === 'string') s.club2 = o.club2;
  if (data.titles.some(t => t.id === o.titleId)) s.titleId = o.titleId;
  s.compare = !!o.compare;
  for (const key of ['a', 'b']) {
    for (const [tid, ov] of Object.entries(o[key] || {})) {
      const n = normaliseOverride(data, tid, ov);
      if (n) s.sets[key][tid] = n;
    }
  }
  return s;
}
