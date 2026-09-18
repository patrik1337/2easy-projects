// Calibration: turns a title's seeds + TVI into per-entry strength weights.
// This is the ONLY place a seed-to-strength rule lives. The engine never sees
// seeds, tiers or TVI; it receives the weights produced here.
//
//   weight = base ^ (1/T),  T = TVI / tviDivisor
//   base   = 1 / seed               methods A, B, C (numeric seed)
//          = tierTable[tier]        method D (the title's own tier table)
//          = 1                      method E, and the session "Random" option
//
// TVI: the approved value when the title is calibrated, otherwise the
// provisional placeholder (50), flagged on every output.

export const TIER_ORDER = ['High', 'Medium', 'Low'];

/** The seed-method options a title offers. Extensible: manual per-entry weights come later. */
export function methodOptions(title) {
  return [
    { id: 'established', label: title.seedMethodLabel, method: title.seedMethod, note: title.seedSource },
    { id: 'random', label: 'Random — all entries equal weight', method: 'E', note: 'Flat weights; identical to method E.' },
  ];
}

/**
 * Seed value used for tier-only entries in a ranked title (e.g. SF6's unranked
 * players). Tier bands tile after the numerically seeded entries in
 * High -> Medium -> Low order, as the SF6 tab defines them; each tier-only
 * entry takes the midpoint of its band.
 */
export function tierBandSeeds(entries) {
  const numeric = entries.filter(e => typeof e.seed === 'number');
  let next = Math.max(numeric.length, ...numeric.map(e => e.seed), 0) + 1;
  const mid = {};
  for (const tier of TIER_ORDER) {
    const count = entries.filter(e => typeof e.seed !== 'number' && e.tier === tier).length;
    if (count) mid[tier] = next + (count - 1) / 2;
    next += count;
  }
  return mid;
}

/** Base strength per entry before temperature, plus a description of where it came from. */
export function baseWeights(title, { method = 'established', tierTable } = {}) {
  const entries = title.entries;
  if (method === 'random' || title.seedKind === 'flat') {
    return entries.map(() => ({ base: 1, from: method === 'random' ? 'random' : 'method E' }));
  }
  if (title.seedKind === 'cohort') {
    const table = tierTable || title.tierTable;
    return entries.map(e => {
      const w = table?.[e.cohort];
      if (!(w > 0)) throw new Error(`${title.id}: no positive tier weight for cohort '${e.cohort}' (${e.entrant})`);
      return { base: w, from: `tier ${e.cohort}` };
    });
  }
  const mids = tierBandSeeds(entries);
  return entries.map(e => {
    if (typeof e.seed === 'number' && e.seed > 0) return { base: 1 / e.seed, from: `seed ${e.seed}` };
    if (e.tier && mids[e.tier]) return { base: 1 / mids[e.tier], from: `tier ${e.tier} → seed ${mids[e.tier]}` };
    throw new Error(`${title.id}: entry ${e.entrant} has no seed`);
  });
}

/** Which TVI applies, and whether it is approved, provisional or a session what-if. */
export function resolveTvi(title, calibration, override = {}) {
  const approved = calibration.approved?.[title.id];
  const defaultTvi = approved ? approved.tvi : calibration.provisionalTvi;
  const defaultSource = approved ? 'approved' : 'provisional';
  if (typeof override.tvi === 'number' && override.tvi !== defaultTvi) {
    return { tvi: override.tvi, source: 'session', defaultTvi, defaultSource };
  }
  return { tvi: defaultTvi, source: defaultSource, defaultTvi, defaultSource };
}

/**
 * Final weights for one title under a session override
 * ({ method?: 'established' | 'random', tvi?: number, tierTable?: {} }).
 */
export function calibrateTitle(title, calibration, override = {}) {
  const method = override.method === 'random' ? 'random' : 'established';
  const bases = baseWeights(title, { method, tierTable: override.tierTable });
  const tvi = resolveTvi(title, calibration, override);
  const T = tvi.tvi / calibration.tviDivisor;
  const weights = bases.map(b => Math.pow(b.base, 1 / T));
  const flat = bases.every(b => b.base === bases[0].base);
  const bMax = Math.max(...bases.map(b => b.base)), bMin = Math.min(...bases.map(b => b.base));
  return {
    titleId: title.id,
    method,
    weights,
    bases,
    tvi,
    temperature: T,
    flat,                                    // temperature has no effect on equal bases
    baseSpan: bMax / bMin,
    effectiveSpan: Math.pow(bMax / bMin, 1 / T),
    calibrated: tvi.defaultSource === 'approved',
  };
}

/** Effective top-to-bottom span for a hypothetical TVI (for the live slider readout). */
export function spanAt(baseSpan, tvi, tviDivisor) {
  return Math.pow(baseSpan, tviDivisor / tvi);
}

/**
 * Build the engine's plain input from data.json + a session parameter set.
 * Returns { input, clubs, provenance } where provenance[titleId] records the
 * TVI actually used and whether it was approved or provisional.
 */
export function buildEngineInput(data, session = {}) {
  const placeholders = new Set(data.placeholderClubs);
  const clubNames = [];
  const clubIndex = new Map();
  for (const t of data.titles) {
    for (const e of t.entries) {
      if (placeholders.has(e.canonical) || clubIndex.has(e.canonical)) continue;
      clubIndex.set(e.canonical, clubNames.length);
      clubNames.push(e.canonical);
    }
  }
  const provenance = {};
  const titles = data.titles.map(t => {
    const cal = calibrateTitle(t, data.calibration, session.titles?.[t.id] || {});
    provenance[t.id] = cal;
    return {
      id: t.id,
      fieldSize: t.fieldSize,
      curve: t.pointsCurve.map(b => ({ from: b.from, points: b.points })),
      entries: t.entries.map((e, i) => ({
        club: placeholders.has(e.canonical) ? -1 : clubIndex.get(e.canonical),
        weight: cal.weights[i],
        void: !!e.void,
      })),
    };
  });
  return {
    input: {
      clubs: clubNames,
      titles,
      rules: {
        eligibilityMinTop8: data.ccRules.eligibilityMinTop8,
        championRequiresTitleWin: data.ccRules.championRequiresTitleWin,
        payingBracket: data.simulationDefaults.payingBracket,
      },
    },
    clubIndex,
    provenance,
  };
}

/** Actual 2026 positions per title (first number of each placement band). */
export function actualPositions(data) {
  return data.titles.map(t => Int32Array.from(t.entries.map(e => e.placeFrom)));
}
