// Read-only views over a simulation result. Main table, summary, club focus
// and investment all derive from these, so they cannot disagree.

export function rankRow(res, c) {
  const w = res.nClubs + 1;
  return res.rankHist.subarray(c * w, c * w + w);
}

export function pRankAtMost(res, c, k) {
  const row = rankRow(res, c);
  let s = 0;
  for (let r = 1; r <= Math.min(k, res.nClubs); r++) s += row[r];
  return s / res.runs;
}

/** P(from <= rank <= to), e.g. ranks 9–16. */
export function pRankBetween(res, c, from, to) {
  return pRankAtMost(res, c, to) - pRankAtMost(res, c, from - 1);
}

export function pRankExact(res, c, r) {
  return r >= 1 && r <= res.nClubs ? rankRow(res, c)[r] / res.runs : 0;
}

/** Smallest value v with P(X <= v) >= q, over a histogram indexed by value. */
function histQuantile(row, total, q, scale = 1, offset = 0) {
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < row.length; i++) {
    cum += row[i];
    if (cum > 0 && cum >= target) return (i + offset) * scale;
  }
  return (row.length - 1 + offset) * scale;
}

export function medianRank(res, c) {
  return histQuantile(rankRow(res, c), res.runs, 0.5);
}

export function pointsRow(res, c) {
  return res.pointsHist.subarray(c * res.nBins, (c + 1) * res.nBins);
}

export function pointsQuantile(res, c, q) {
  return histQuantile(pointsRow(res, c), res.runs, q, res.pointsBinWidth);
}

export function meanPoints(res, c) {
  return res.pointsSum[c] / res.runs;
}

/** Club focus: probability of each placement 1..payingBracket, then one outside-bracket bucket. */
export function placementBuckets(res, c) {
  const B = res.buckets;
  const counts = Array.from(res.bucketCount.subarray(c * B, c * B + B));
  return counts.map((n, b) => ({
    bucket: b,
    label: b === B - 1 ? `${B}th or worse` : String(b + 1),
    outside: b === B - 1,
    p: n / res.runs,
    runs: n,
    avgTitlesWon: n ? res.bucketWins[c * B + b] / n : null,
  }));
}

/** Route: in runs where the club finished inside [fromBucket, toBucket], which titles did it win? */
export function routeFor(res, c, fromBucket, toBucket) {
  const B = res.buckets, T = res.nTitles;
  let runs = 0, wins = 0;
  const perTitle = new Float64Array(T);
  for (let b = fromBucket; b <= toBucket; b++) {
    runs += res.bucketCount[c * B + b];
    wins += res.bucketWins[c * B + b];
    const base = (c * B + b) * T;
    for (let t = 0; t < T; t++) perTitle[t] += res.bucketTitleWins[base + t];
  }
  const titles = Array.from(perTitle, (n, t) => ({ title: t, winRuns: n, share: runs ? n / runs : 0 }))
    .filter(x => x.winRuns > 0)
    .sort((a, b) => b.winRuns - a.winRuns);
  return { runs, p: runs / res.runs, avgTitlesWon: runs ? wins / runs : null, titles };
}

/** Distribution of a club's scored result in one title, over that title's attainable tiers. */
export function clubTitleTiers(res, c, t, nTiers) {
  const base = (c * res.nTitles + t) * res.maxTiers;
  const counts = Array.from(res.clubTitleTier.subarray(base, base + nTiers));
  const total = counts.reduce((a, b) => a + b, 0);
  return total ? counts.map(n => n / total) : null;
}

export function entryTiers(res, t, i, nTiers) {
  const row = res.entryTier[t].subarray(i * nTiers, (i + 1) * nTiers);
  return Array.from(row, n => n / res.runs);
}

export function clubSummary(res, c, actual) {
  const aRank = actual ? actual.rank[c] : null;
  return {
    pExactActual: aRank ? pRankExact(res, c, aRank) : null,
    pWin: pRankExact(res, c, 1),
    pTop3: pRankAtMost(res, c, 3),
    pTop8: pRankAtMost(res, c, 8),
    pTop24: pRankAtMost(res, c, res.buckets - 1),
    p9to16: pRankBetween(res, c, 9, 16),
    p17to24: pRankBetween(res, c, 17, 24),
    medianRank: medianRank(res, c),
    meanPoints: meanPoints(res, c),
    medianPoints: pointsQuantile(res, c, 0.5),
    p10: pointsQuantile(res, c, 0.1),
    p90: pointsQuantile(res, c, 0.9),
    pEligible: res.eligibleRuns[c] / res.runs,
    actualPoints: actual ? actual.total[c] : null,
    actualRank: aRank,
  };
}
