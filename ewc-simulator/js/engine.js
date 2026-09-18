// EWC Club Championship Monte Carlo engine. Pure functions, no DOM.
//
// The engine knows nothing about seeds, cohorts, TVI or temperature. Every
// entry arrives with a finished strength weight (a positive number computed
// upstream in calibration.js). The engine's job:
//   1. draw a full finishing order per title, per run, by Plackett-Luce
//      (weighted sampling without replacement),
//   2. score positions on the title's points curve (voided entries score 0),
//   3. keep each club's best entry per title and sum across titles,
//   4. rank clubs by the official Club Championship rules,
//   5. aggregate exact ranks, points and routes across runs.

// ------------------------------------------------------------ points curves

/** '5-8' | '5–8' | 3 | '17' -> { from, to } */
export function parsePlacement(label) {
  if (typeof label === 'number') return { from: label, to: label };
  const m = String(label).trim().replace(/[–—]/g, '-').match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) throw new Error(`Unparseable placement: ${label}`);
  const from = Number(m[1]);
  return { from, to: m[2] ? Number(m[2]) : from };
}

/** Points for a finishing position: the band with the largest `from` <= position. */
export function curvePoints(curve, position) {
  let pts = 0;
  for (const band of curve) if (band.from <= position) pts = band.points;
  return pts;
}

/** Index of the curve band containing `position`. */
export function tierIndex(curve, position) {
  let idx = 0;
  for (let i = 0; i < curve.length; i++) if (curve[i].from <= position) idx = i;
  return idx;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Attainable outcomes of a title: one tier per curve band. */
export function curveTiers(curve, fieldSize) {
  return curve.map((band, i) => {
    const to = i + 1 < curve.length ? curve[i + 1].from - 1 : fieldSize;
    const label = band.from === to ? ordinal(band.from) : `${ordinal(band.from)}–${ordinal(to)}`;
    return { index: i, from: band.from, to, points: band.points, label };
  });
}

// ------------------------------------------------------------ model

/**
 * Compile plain input into typed arrays.
 * input = {
 *   clubs: [name],
 *   titles: [{ id, fieldSize, curve: [{from, points}], entries: [{ club: index | -1, weight, void }] }],
 *   rules: { eligibilityMinTop8, championRequiresTitleWin, payingBracket }
 * }
 */
export function compileModel(input) {
  const nClubs = input.clubs.length;
  const titles = input.titles.map((t, ti) => {
    const n = t.entries.length;
    const logW = new Float64Array(n);
    const club = new Int32Array(n);
    const isVoid = new Uint8Array(n);
    t.entries.forEach((e, i) => {
      if (!(typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0)) {
        throw new Error(`Title ${t.id} entry ${i}: weight must be a positive finite number, got ${e.weight}`);
      }
      logW[i] = Math.log(e.weight);
      club[i] = e.club;
      isVoid[i] = e.void ? 1 : 0;
      if (e.club < -1 || e.club >= nClubs) throw new Error(`Title ${t.id} entry ${i}: bad club index ${e.club}`);
    });
    const fieldSize = Math.max(t.fieldSize || 0, n);
    const pointsAt = new Int32Array(fieldSize + 1);
    const tierAt = new Int32Array(fieldSize + 1);
    for (let p = 1; p <= fieldSize; p++) {
      pointsAt[p] = curvePoints(t.curve, p);
      tierAt[p] = tierIndex(t.curve, p);
    }
    const tierOfPoints = new Map();
    t.curve.forEach((b, i) => { if (!tierOfPoints.has(b.points)) tierOfPoints.set(b.points, i); });
    if (!tierOfPoints.has(0)) tierOfPoints.set(0, t.curve.length - 1);
    const clubsIn = [...new Set(t.entries.map(e => e.club).filter(c => c >= 0))];
    return { id: t.id, index: ti, n, fieldSize, logW, club, isVoid, pointsAt, tierAt, tierOfPoints,
      nTiers: t.curve.length, clubsIn: Int32Array.from(clubsIn), curve: t.curve };
  });
  const rules = {
    eligibilityMinTop8: input.rules?.eligibilityMinTop8 ?? 2,
    championRequiresTitleWin: input.rules?.championRequiresTitleWin ?? true,
    payingBracket: input.rules?.payingBracket ?? 24,
  };
  let g = 0;
  for (const t of titles) for (const b of t.curve) g = gcd(g, b.points);
  const maxTotal = titles.reduce((s, t) => s + Math.max(0, ...t.curve.map(b => b.points)), 0);
  return {
    nClubs, clubs: input.clubs, titles, rules,
    nTitles: titles.length,
    nEntries: titles.reduce((s, t) => s + t.n, 0),
    maxTiers: Math.max(...titles.map(t => t.nTiers)),
    pointsBinWidth: g || 1,
    maxTotal,
  };
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }

// ------------------------------------------------------------ Plackett-Luce draw

/**
 * Sample a full finishing order. Gumbel-max: key_i = log w_i + Gumbel noise,
 * sorted descending. Distributionally identical to picking 1st proportional
 * to weight, removing it, picking 2nd from the remainder, and so on.
 * Writes positions (1-based) into `positions` for this title's entries.
 */
export function drawPositions(title, rng, positions, scratch) {
  const n = title.n;
  const keys = scratch.keys;
  const idx = scratch.idx;
  for (let i = 0; i < n; i++) {
    keys[i] = title.logW[i] - Math.log(-Math.log(rng()));
    idx[i] = i;
  }
  const sub = idx.subarray(0, n);
  sub.sort((a, b) => keys[b] - keys[a]);
  for (let p = 0; p < n; p++) positions[sub[p]] = p + 1;
  return positions;
}

// ------------------------------------------------------------ scoring & ranking

/** Per-run working buffers, reused to avoid allocation in the hot loop. */
export function createRunState(model) {
  const { nClubs, nTitles } = model;
  const maxN = Math.max(...model.titles.map(t => t.n));
  return {
    positions: model.titles.map(t => new Int32Array(t.n)),
    keys: new Float64Array(maxN),
    idx: new Int32Array(maxN),
    total: new Int32Array(nClubs),
    wins: new Int32Array(nClubs),
    top8: new Int32Array(nClubs),
    titlePts: new Int32Array(nClubs * nTitles),
    best: new Int32Array(nClubs).fill(-1),
    top8Flag: new Uint8Array(nClubs),
    rank: new Int32Array(nClubs),
    sortKeys: new Float64Array(nClubs),
    winList: [],
  };
}

/**
 * Score one run from entry positions (simulated or actual). Fills
 * state.total / wins / top8 / titlePts / winList.
 */
export function scoreRun(model, state) {
  const { nTitles } = model;
  state.total.fill(0); state.wins.fill(0); state.top8.fill(0); state.titlePts.fill(0);
  state.winList.length = 0;
  for (let ti = 0; ti < nTitles; ti++) {
    const t = model.titles[ti];
    const pos = state.positions[ti];
    for (let i = 0; i < t.n; i++) {
      const c = t.club[i];
      if (c < 0) continue;                           // placeholder entrant: occupies a place, never scores
      const p = pos[i];
      const pts = t.isVoid[i] ? 0 : t.pointsAt[p];   // voided entries score zero wherever they finish
      if (pts > state.best[c]) state.best[c] = pts;  // best entry per club per title (MAX, not sum)
      if (!t.isVoid[i]) {
        if (p <= 8) state.top8Flag[c] = 1;
        if (p === 1) { state.wins[c]++; state.winList.push(c, ti); }
      }
    }
    for (let k = 0; k < t.clubsIn.length; k++) {
      const c = t.clubsIn[k];
      const b = state.best[c];
      state.total[c] += b;
      state.titlePts[c * nTitles + ti] = b;
      state.top8[c] += state.top8Flag[c];
      state.best[c] = -1;
      state.top8Flag[c] = 0;
    }
  }
}

/** Olympic medal logic: compare best single results, then next best, ... >0 means a ranks above b. */
export function medalCompare(model, state, a, b) {
  const n = model.nTitles;
  const va = Array.from(state.titlePts.subarray(a * n, a * n + n)).sort((x, y) => y - x);
  const vb = Array.from(state.titlePts.subarray(b * n, b * n + n)).sort((x, y) => y - x);
  for (let i = 0; i < n; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  return 0;
}

/**
 * Rank clubs by the official Club Championship rules (see data.json ccRules):
 *  - points, descending;
 *  - on equal points, eligible clubs (>= eligibilityMinTop8 top-8 finishes) above ineligible;
 *  - 1st place goes to the club(s) eligible to win (eligible + a title win) with the most points,
 *    a tie broken by medal logic; any tie still left shares 1st;
 *  - every other tie shares the rank (standard competition ranking, "6=").
 * Never random. Writes 1-based ranks into state.rank.
 */
export function rankClubs(model, state) {
  const { nClubs, rules } = model;
  const { total, top8, wins, rank, sortKeys } = state;
  const eligible = c => top8[c] >= rules.eligibilityMinTop8;
  const key = c => total[c] * 2 + (eligible(c) ? 1 : 0);
  for (let c = 0; c < nClubs; c++) sortKeys[c] = key(c) * 65536 + (65535 - c);
  sortKeys.sort();
  const order = new Int32Array(nClubs);
  for (let i = 0; i < nClubs; i++) order[i] = 65535 - (sortKeys[nClubs - 1 - i] % 65536);

  // Champions.
  const champs = [];
  const canWin = c => eligible(c) && (!rules.championRequiresTitleWin || wins[c] > 0);
  let topKey = null;
  for (let i = 0; i < nClubs; i++) {
    const c = order[i];
    if (!canWin(c)) continue;
    if (topKey === null) topKey = key(c);
    if (key(c) !== topKey) break;
    champs.push(c);
  }
  let champSet = champs;
  if (champs.length > 1) {
    champSet = [champs[0]];
    for (let i = 1; i < champs.length; i++) {
      const cmp = medalCompare(model, state, champs[i], champSet[0]);
      if (cmp > 0) champSet = [champs[i]];
      else if (cmp === 0) champSet.push(champs[i]);
    }
  }
  const isChamp = new Uint8Array(nClubs);
  for (const c of champSet) { isChamp[c] = 1; rank[c] = 1; }

  let seen = 0, prevKey = null, groupRank = 0;
  for (let i = 0; i < nClubs; i++) {
    const c = order[i];
    if (isChamp[c]) continue;
    const k = key(c);
    if (k !== prevKey) { groupRank = 1 + champSet.length + seen; prevKey = k; }
    rank[c] = groupRank;
    seen++;
  }
  return rank;
}

// ------------------------------------------------------------ actual result

/** Score and rank the actual result: every entry placed at the first number of its placement band. */
export function evaluateActual(model, actualPositions) {
  const state = createRunState(model);
  model.titles.forEach((t, ti) => state.positions[ti].set(actualPositions[ti]));
  scoreRun(model, state);
  rankClubs(model, state);
  return {
    total: Int32Array.from(state.total),
    wins: Int32Array.from(state.wins),
    top8: Int32Array.from(state.top8),
    titlePts: Int32Array.from(state.titlePts),
    rank: Int32Array.from(state.rank),
  };
}

// ------------------------------------------------------------ simulation

export function bucketOf(model, rank) {
  return Math.min(rank, model.rules.payingBracket + 1) - 1;   // 0..payingBracket-1 exact, last = outside bracket
}

/**
 * Run the Monte Carlo. Every view (tables, club focus, investment) reads
 * these aggregates, so no two views can come from different executions.
 */
export function simulate(model, { runs, rng, onProgress, progressEvery = 500 }) {
  const { nClubs, nTitles, maxTiers } = model;
  const B = model.rules.payingBracket + 1;
  const nBins = Math.floor(model.maxTotal / model.pointsBinWidth) + 1;
  const out = {
    runs,
    nClubs, nTitles, maxTiers, buckets: B, pointsBinWidth: model.pointsBinWidth, nBins,
    rankHist: new Int32Array(nClubs * (nClubs + 1)),         // [club][rank]
    pointsHist: new Int32Array(nClubs * nBins),              // [club][total / binWidth]
    pointsSum: new Float64Array(nClubs),
    winsSum: new Float64Array(nClubs),
    eligibleRuns: new Int32Array(nClubs),
    bucketCount: new Int32Array(nClubs * B),                 // [club][bucket]
    bucketWins: new Float64Array(nClubs * B),                // titles won, summed, [club][bucket]
    bucketTitleWins: new Int32Array(nClubs * B * nTitles),   // [club][bucket][title]
    clubTitleTier: new Int32Array(nClubs * nTitles * maxTiers), // club's scored result per title
    clubTitlePointsSum: new Float64Array(nClubs * nTitles),  // for ordering only; never displayed per title
    entryTier: model.titles.map(t => new Int32Array(t.n * t.nTiers)),
  };
  const state = createRunState(model);
  for (let r = 0; r < runs; r++) {
    for (let ti = 0; ti < nTitles; ti++) drawPositions(model.titles[ti], rng, state.positions[ti], state);
    scoreRun(model, state);
    rankClubs(model, state);
    accumulate(model, state, out);
    if (onProgress && (r + 1) % progressEvery === 0) onProgress(r + 1, runs);
  }
  if (onProgress) onProgress(runs, runs);
  return out;
}

function accumulate(model, state, out) {
  const { nClubs, nTitles, maxTiers, rules } = model;
  const B = out.buckets;
  for (let c = 0; c < nClubs; c++) {
    const rk = state.rank[c];
    out.rankHist[c * (nClubs + 1) + rk]++;
    out.pointsHist[c * out.nBins + Math.floor(state.total[c] / out.pointsBinWidth)]++;
    out.pointsSum[c] += state.total[c];
    out.winsSum[c] += state.wins[c];
    if (state.top8[c] >= rules.eligibilityMinTop8) out.eligibleRuns[c]++;
    const b = bucketOf(model, rk);
    out.bucketCount[c * B + b]++;
    out.bucketWins[c * B + b] += state.wins[c];
  }
  const wl = state.winList;
  for (let i = 0; i < wl.length; i += 2) {
    const c = wl[i], ti = wl[i + 1];
    out.bucketTitleWins[(c * B + bucketOf(model, state.rank[c])) * nTitles + ti]++;
  }
  for (let ti = 0; ti < nTitles; ti++) {
    const t = model.titles[ti];
    for (let k = 0; k < t.clubsIn.length; k++) {
      const c = t.clubsIn[k];
      const pts = state.titlePts[c * nTitles + ti];
      out.clubTitleTier[(c * nTitles + ti) * maxTiers + t.tierOfPoints.get(pts)]++;
      out.clubTitlePointsSum[c * nTitles + ti] += pts;
    }
    const pos = state.positions[ti], et = out.entryTier[ti];
    for (let i = 0; i < t.n; i++) et[i * t.nTiers + t.tierAt[pos[i]]]++;
  }
}

/** Typed-array buffers of a result, for zero-copy postMessage. */
export function resultTransferables(res) {
  return [res.rankHist, res.pointsHist, res.pointsSum, res.winsSum, res.eligibleRuns, res.bucketCount,
    res.bucketWins, res.bucketTitleWins, res.clubTitleTier, res.clubTitlePointsSum, ...res.entryTier].map(a => a.buffer);
}
