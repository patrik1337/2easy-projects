// Investment layer: optional post-processing over simulation output. Never
// touches the engine or calibration. Every figure is an estimate and carries
// its confidence label.

import { pointsRow, meanPoints } from './stats.js';

export const CONFIDENCE = ['high', 'medium', 'low', 'estimate'];

export function investmentIndex(data) {
  const m = new Map();
  for (const row of data.investment || []) if (row && row.club && row.annualSpend > 0) m.set(row.club, row);
  return m;
}

/**
 * Cost-per-point distribution from the simulated points histogram. Runs where
 * the club scores 0 have no defined cost per point; they are reported as a
 * share, not folded into the numbers.
 */
function costPerPointQuantiles(res, c, spend) {
  const row = pointsRow(res, c);
  const zero = row[0] / res.runs;
  const scoring = res.runs - row[0];
  if (!scoring) return { zeroShare: 1, p10: null, median: null, p90: null };
  // Cost per point decreases as points increase: the P10 cost comes from the P90 points.
  const pointsAt = q => {
    const target = q * scoring;
    let cum = 0;
    for (let i = 1; i < row.length; i++) { cum += row[i]; if (cum >= target && cum > 0) return i * res.pointsBinWidth; }
    return (row.length - 1) * res.pointsBinWidth;
  };
  return { zeroShare: zero, p10: spend / pointsAt(0.9), median: spend / pointsAt(0.5), p90: spend / pointsAt(0.1) };
}

export function investmentMetrics(data, res, actual, clubIndex) {
  const idx = investmentIndex(data);
  const entered = new Map();
  for (const t of data.titles) for (const e of t.entries) {
    if (!entered.has(e.canonical)) entered.set(e.canonical, new Set());
    entered.get(e.canonical).add(t.id);
  }
  const rows = [];
  for (const [club, inv] of idx) {
    const c = clubIndex.get(club);
    if (c === undefined) { rows.push({ club, inv, missing: true }); continue; }
    const actualPts = actual.total[c];
    const mean = meanPoints(res, c);
    const titles = entered.get(club)?.size || 0;
    rows.push({
      club, inv,
      confidence: inv.confidence,
      titlesEntered: titles,
      actualPoints: actualPts,
      pointsPerTitleActual: titles ? actualPts / titles : null,
      pointsPerTitleSimMean: titles ? mean / titles : null,
      costPerPointActual: actualPts > 0 ? inv.annualSpend / actualPts : null,
      costPerPointSim: costPerPointQuantiles(res, c, inv.annualSpend),
      pointsPerUnitActual: actualPts / inv.annualSpend,
      pointsPerUnitSimMean: mean / inv.annualSpend,
      actualVsSim: mean > 0 ? actualPts / mean : null,
    });
  }
  return rows;
}
