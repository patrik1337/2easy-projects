// Admin-side validation and diff over a working copy of data.json. Pure.
import { compileModel, evaluateActual, parsePlacement } from './engine.js';
import { buildEngineInput, actualPositions, baseWeights } from './calibration.js';

export function validateData(data) {
  const errors = [];
  const placeholders = new Set(data.placeholderClubs);
  const registry = new Set(data.clubs.map(c => c.name));

  // Club registry: unique names and ids.
  const seenName = new Set(), seenId = new Set();
  for (const c of data.clubs) {
    if (!c.name) errors.push({ area: 'clubs', msg: `Club with id '${c.id}' has no name` });
    if (seenName.has(c.name)) errors.push({ area: 'clubs', msg: `Duplicate club name '${c.name}'` });
    if (seenId.has(c.id)) errors.push({ area: 'clubs', msg: `Duplicate club id '${c.id}'` });
    seenName.add(c.name); seenId.add(c.id);
  }

  for (const t of data.titles) {
    if (!['A', 'B', 'C', 'D', 'E'].includes(t.seedMethod)) errors.push({ area: t.id, msg: `Seed method '${t.seedMethod}' is not A–E` });
    const curve = t.pointsCurve;
    if (!curve.length || curve[0].from !== 1) errors.push({ area: t.id, msg: 'Points curve must start at place 1' });
    for (let i = 1; i < curve.length; i++) {
      if (!(curve[i].from > curve[i - 1].from)) errors.push({ area: t.id, msg: `Points curve 'from' places must increase (row ${i + 1})` });
    }
    if (curve.some(b => !Number.isInteger(b.points) || b.points < 0)) errors.push({ area: t.id, msg: 'Curve points must be non-negative integers' });
    if (t.seedKind === 'cohort' && t.tierTable) {
      for (const [k, v] of Object.entries(t.tierTable)) if (!(v > 0)) errors.push({ area: t.id, msg: `Tier weight ${k} must be > 0` });
    }
    t.entries.forEach((e, i) => {
      const where = `${t.short} · ${e.entrant || `entry ${i + 1}`}`;
      if (!e.canonical) errors.push({ area: t.id, msg: `${where}: no canonical club` });
      else if (!placeholders.has(e.canonical) && !registry.has(e.canonical)) {
        errors.push({ area: t.id, msg: `${where}: canonical '${e.canonical}' is orphaned (not in the club registry)` });
      }
      try {
        const p = parsePlacement(e.placement);
        if (p.from !== e.placeFrom || p.to !== e.placeTo) errors.push({ area: t.id, msg: `${where}: placement fields out of sync` });
        if (p.from < 1 || p.to > Math.max(t.fieldSize, t.entries.length)) errors.push({ area: t.id, msg: `${where}: placement ${e.placement} outside field` });
      } catch { errors.push({ area: t.id, msg: `${where}: unparseable placement '${e.placement}'` }); }
    });
    try { baseWeights(t); } catch (err) { errors.push({ area: t.id, msg: `Seed missing: ${err.message}` }); }
    const approved = data.calibration.approved[t.id];
    if (approved && !(Number.isInteger(approved.tvi) && approved.tvi >= 1 && approved.tvi <= 100)) {
      errors.push({ area: t.id, msg: `Approved TVI must be an integer 1–100` });
    }
  }

  // Reconciliation: actual placements through the engine must hit every official total.
  let reconciled = 0;
  try {
    const { input, clubIndex } = buildEngineInput(data);
    const model = compileModel(input);
    const actual = evaluateActual(model, actualPositions(data));
    for (const row of data.reconciliation) {
      const c = clubIndex.get(row.club);
      const got = c === undefined ? 0 : actual.total[c];
      const want = row.officialTotal ?? 0;
      if (got !== want) errors.push({ area: 'reconciliation', msg: `${row.club}: scores ${got} from actual placements, official total is ${want}` });
      else reconciled++;
    }
  } catch (err) {
    errors.push({ area: 'engine', msg: `Could not score actual placements: ${err.message}` });
  }

  for (const r of data.investment || []) {
    if (!registry.has(r.club)) errors.push({ area: 'investment', msg: `Investment row for unknown club '${r.club}'` });
    if (!(r.annualSpend > 0)) errors.push({ area: 'investment', msg: `${r.club}: spend must be > 0` });
    if (!['high', 'medium', 'low', 'estimate'].includes(r.confidence)) errors.push({ area: 'investment', msg: `${r.club}: confidence must be high/medium/low/estimate` });
    if (!r.currency) errors.push({ area: 'investment', msg: `${r.club}: currency required` });
  }
  return { ok: errors.length === 0, errors, reconciled, reconciliationRows: data.reconciliation.length };
}

/** Flat list of changed leaf paths between two JSON values. */
export function diffJson(before, after, path = '', out = []) {
  if (before === after) return out;
  const isObj = v => v && typeof v === 'object';
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ path: path || '(root)', before, after });
    return out;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const p = Array.isArray(after) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    if (!(k in before)) out.push({ path: p, before: undefined, after: after[k] });
    else if (!(k in after)) out.push({ path: p, before: before[k], after: undefined });
    else diffJson(before[k], after[k], p, out);
  }
  return out;
}

/** Make a diff path readable: titles[3].entries[5].seed -> "Tekken 8 · Rangchu · seed". */
export function describePath(data, path) {
  const m = /^titles\[(\d+)\](?:\.entries\[(\d+)\])?\.?(.*)$/.exec(path);
  if (m) {
    const t = data.titles[+m[1]];
    const e = m[2] !== undefined ? t?.entries[+m[2]] : null;
    return [t?.short, e ? (e.player || e.entrant) : null, m[3]].filter(Boolean).join(' · ');
  }
  const c = /^clubs\[(\d+)\]\.?(.*)$/.exec(path);
  if (c) return ['Club', data.clubs[+c[1]]?.name, c[2]].filter(Boolean).join(' · ');
  return path;
}
