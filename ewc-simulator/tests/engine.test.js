import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parsePlacement, curvePoints, curveTiers, compileModel, createRunState, drawPositions,
  scoreRun, rankClubs, evaluateActual, simulate,
} from '../js/engine.js';
import { calibrateTitle, buildEngineInput, actualPositions, baseWeights, tierBandSeeds } from '../js/calibration.js';
import { createRng } from '../js/rng.js';
import { clubSummary, placementBuckets, pRankAtMost, rankRow, routeFor } from '../js/stats.js';

const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8'));
const PLAYOFF = [{ from: 1, points: 1000 }, { from: 2, points: 750 }, { from: 3, points: 500 },
  { from: 4, points: 300 }, { from: 5, points: 200 }, { from: 9, points: 0 }];
const BR = [{ from: 1, points: 1000 }, { from: 2, points: 750 }, { from: 3, points: 500 }, { from: 4, points: 300 },
  { from: 5, points: 200 }, { from: 6, points: 150 }, { from: 7, points: 100 }, { from: 8, points: 50 }, { from: 9, points: 0 }];
const RULES = { eligibilityMinTop8: 2, championRequiresTitleWin: true, payingBracket: 24 };

/** Tiny hand-built model: positions are set directly, no draw. */
function fixedRun(model, positionsPerTitle) {
  const st = createRunState(model);
  positionsPerTitle.forEach((p, ti) => st.positions[ti].set(p));
  scoreRun(model, st);
  rankClubs(model, st);
  return st;
}
const entry = (club, extra = {}) => ({ club, weight: 1, void: false, ...extra });

describe('points curve lookup', () => {
  test('parses banded and exact placements', () => {
    assert.deepEqual(parsePlacement('5-8'), { from: 5, to: 8 });
    assert.deepEqual(parsePlacement('17–24'), { from: 17, to: 24 });
    assert.deepEqual(parsePlacement(3), { from: 3, to: 3 });
  });
  test('banded placements score the band value', () => {
    for (const p of [5, 6, 7, 8]) assert.equal(curvePoints(PLAYOFF, p), 200);
    assert.equal(curvePoints(PLAYOFF, parsePlacement('5-8').from), 200);
    assert.equal(curvePoints(PLAYOFF, parsePlacement('17-24').from), 0);
    assert.equal(curvePoints(PLAYOFF, 9), 0);
    assert.equal(curvePoints(BR, 6), 150);
    assert.equal(curvePoints(BR, 8), 50);
    const tm = data.titles.find(t => t.id === 'trackmania').pointsCurve;
    assert.equal(curvePoints(tm, parsePlacement('7-8').from), 100);
    assert.equal(curvePoints(tm, parsePlacement('17-20').from), 0);
  });
  test('tiers are the attainable outcomes', () => {
    assert.deepEqual(curveTiers(PLAYOFF, 32).map(t => [t.label, t.points]),
      [['1st', 1000], ['2nd', 750], ['3rd', 500], ['4th', 300], ['5th–8th', 200], ['9th–32nd', 0]]);
  });
  test('every extracted entry scores its sheet points', () => {
    for (const t of data.titles) for (const e of t.entries) assert.equal(curvePoints(t.pointsCurve, e.placeFrom), e.sheetPoints, `${t.id} ${e.entrant}`);
  });
});

describe('scoring', () => {
  test('best entry per club: a club with 1st and 2nd scores 1000, and the 750 goes to nobody', () => {
    const model = compileModel({ clubs: ['A', 'B'], rules: RULES,
      titles: [{ id: 't', fieldSize: 4, curve: PLAYOFF, entries: [entry(0), entry(0), entry(1), entry(-1)] }] });
    const st = fixedRun(model, [[1, 2, 3, 4]]);
    assert.equal(st.total[0], 1000);
    assert.equal(st.total[1], 500);
    assert.equal(st.total[0] + st.total[1], 1500);
  });
  test('two entries: the better one scores even when listed second', () => {
    const model = compileModel({ clubs: ['A'], rules: RULES,
      titles: [{ id: 't', fieldSize: 8, curve: PLAYOFF, entries: [entry(0), entry(0)] }] });
    assert.equal(fixedRun(model, [[7, 3]]).total[0], 500);
  });
  test('voided entries score zero wherever they finish, and do not count as wins or top-8s', () => {
    const model = compileModel({ clubs: ['A', 'B'], rules: RULES,
      titles: [{ id: 't', fieldSize: 4, curve: PLAYOFF, entries: [entry(0, { void: true }), entry(1)] }] });
    const st = fixedRun(model, [[1, 2]]);
    assert.equal(st.total[0], 0);
    assert.equal(st.wins[0], 0);
    assert.equal(st.top8[0], 0);
    assert.equal(st.total[1], 750);
  });
  test('placeholder entrants occupy positions but never score', () => {
    const model = compileModel({ clubs: ['A'], rules: RULES,
      titles: [{ id: 't', fieldSize: 2, curve: PLAYOFF, entries: [entry(-1), entry(0)] }] });
    assert.equal(fixedRun(model, [[1, 2]]).total[0], 750);
  });
});

describe('ranking rule', () => {
  // Two titles; clubs index 0..3.
  const mk = (titleEntries) => compileModel({ clubs: ['A', 'B', 'C', 'D'], rules: RULES,
    titles: titleEntries.map((entries, i) => ({ id: `t${i}`, fieldSize: 16, curve: PLAYOFF, entries })) });

  test('ties below 1st share the rank', () => {
    // A wins both (2000). B: 750+200=950. C: 500+300... make B and C equal and eligible.
    const model = mk([[entry(0), entry(1), entry(2), entry(3)], [entry(0), entry(2), entry(1), entry(3)]]);
    const st = fixedRun(model, [[1, 2, 3, 4], [1, 2, 3, 4]]);
    assert.equal(st.total[1], st.total[2]);
    assert.equal(st.rank[0], 1);
    assert.equal(st.rank[1], 2);
    assert.equal(st.rank[2], 2);
    assert.equal(st.rank[3], 4);
  });
  test('on equal points, eligible clubs rank above ineligible', () => {
    // A: 1000 from one title (ineligible). B: 500 + 500? use 750 + 200 + ... build B = 750+250 not possible; use third title.
    const model = compileModel({ clubs: ['A', 'B', 'X'], rules: RULES, titles: [
      { id: 'a', fieldSize: 16, curve: PLAYOFF, entries: [entry(0), entry(2), entry(1)] },  // A 1st, X 2nd, B 3rd (500)
      { id: 'b', fieldSize: 16, curve: PLAYOFF, entries: [entry(2), entry(1)] },            // X 1st, B 3rd (500)
    ] });
    const st = fixedRun(model, [[1, 2, 3], [1, 3]]);
    assert.equal(st.total[0], 1000); assert.equal(st.total[1], 1000);
    assert.ok(st.rank[1] < st.rank[0], 'eligible B above ineligible A');
  });
  test('a tie for 1st is broken by medal logic', () => {
    // A: 1000 + 500 = 1500. B: 750 + 750 = 1500. Both eligible, A has a win -> A 1st by medals and by win rule.
    // C: 1000 + 500 too, but in a different order: identical medals with A -> shared 1st.
    const model = compileModel({ clubs: ['A', 'B', 'C'], rules: RULES, titles: [
      { id: 'a', fieldSize: 16, curve: PLAYOFF, entries: [entry(0), entry(1), entry(2)] },
      { id: 'b', fieldSize: 16, curve: PLAYOFF, entries: [entry(2), entry(1), entry(0)] },
      { id: 'c', fieldSize: 16, curve: PLAYOFF, entries: [entry(1)] },
    ] });
    const st = fixedRun(model, [[1, 2, 3], [1, 2, 3], [9]]);
    assert.deepEqual([st.total[0], st.total[1], st.total[2]], [1500, 1500, 1500]);
    assert.equal(st.rank[0], 1);
    assert.equal(st.rank[2], 1);
    assert.equal(st.rank[1], 3);
  });
  test('a club without a title win cannot be ranked 1st', () => {
    // A: 750+750+750 = 2250, no win. B: 1000+1000 = 2000 with wins.
    const model = compileModel({ clubs: ['A', 'B'], rules: RULES, titles: [
      { id: 'a', fieldSize: 16, curve: PLAYOFF, entries: [entry(1), entry(0)] },
      { id: 'b', fieldSize: 16, curve: PLAYOFF, entries: [entry(1), entry(0)] },
      { id: 'c', fieldSize: 16, curve: PLAYOFF, entries: [entry(0)] },
    ] });
    const st = fixedRun(model, [[1, 2], [1, 2], [2]]);
    assert.equal(st.total[0], 2250);
    assert.equal(st.rank[1], 1);
    assert.equal(st.rank[0], 2);
  });
  test('actual 2026 ranks agree with the published standings', () => {
    const { input, clubIndex } = buildEngineInput(data);
    const model = compileModel(input);
    const actual = evaluateActual(model, actualPositions(data));
    const byRank = new Map();
    for (let c = 0; c < model.nClubs; c++) byRank.set(actual.rank[c], (byRank.get(actual.rank[c]) || 0) + 1);
    // HavoK by Vitality and Ekletyc score in the title tabs but are absent from
    // the official standings, so they push lower clubs down one place each.
    const official = new Set(data.reconciliation.map(r => r.club));
    const extra = [...clubIndex].filter(([name, c]) => !official.has(name) && actual.total[c] > 0).map(([, c]) => c);
    assert.deepEqual(extra.map(c => model.clubs[c]).sort(), ['Ekletyc', 'HavoK by Vitality']);
    for (const ref of data.workbookReferenceRun.clubs) {
      const c = clubIndex.get(ref.club);
      const shift = extra.filter(x => actual.rank[x] < actual.rank[c]).length;
      const r = actual.rank[c] - shift, group = byRank.get(actual.rank[c]);
      // Published order lists tied clubs one after another; ours shares the first rank of the group.
      assert.ok(ref.actualRank >= r && ref.actualRank <= r + group - 1, `${ref.club}: published ${ref.actualRank}, engine ${r} (group of ${group})`);
    }
    assert.equal(actual.rank[clubIndex.get('AG.AL International')], 1);
    assert.equal(actual.rank[clubIndex.get('Team Spirit')], 6);
    assert.equal(actual.rank[clubIndex.get('Virtus.pro')], 6);
  });
});

describe('integrity', () => {
  test('actual placements substituted for the draw reproduce every official CC total exactly', () => {
    const { input, clubIndex } = buildEngineInput(data);
    const model = compileModel(input);
    const actual = evaluateActual(model, actualPositions(data));
    let checked = 0;
    for (const row of data.reconciliation) {
      const c = clubIndex.get(row.club);
      const got = c === undefined ? 0 : actual.total[c];
      assert.equal(got, row.officialTotal ?? 0, `${row.club}`);
      data.titles.forEach((t, ti) => {
        const per = c === undefined ? 0 : actual.titlePts[c * model.nTitles + ti];
        assert.equal(per, row.perTitle[t.id] ?? 0, `${row.club} / ${t.id}`);
      });
      checked++;
    }
    assert.equal(checked, 154);
  });
});

describe('calibration (upstream of the engine)', () => {
  const cal = data.calibration;
  const t = id => data.titles.find(x => x.id === id);

  test('a cohort weight is unaffected by how many teams are in the cohort', () => {
    const base = t('lol');
    const oneHigh = { ...base, entries: base.entries.map((e, i) => ({ ...e, cohort: i === 0 ? 'High' : 'Low' })) };
    const allHigh = { ...base, entries: base.entries.map(e => ({ ...e, cohort: 'High' })) };
    const w1 = calibrateTitle(oneHigh, cal).weights[0];
    const w2 = calibrateTitle(allHigh, cal).weights[0];
    assert.equal(w1, w2);
    assert.equal(baseWeights(oneHigh)[0].base, 3);
  });
  test('every title runs on its workbook TVI; CS2 stays on its locked approved 52', () => {
    for (const title of data.titles) {
      const r = calibrateTitle(title, cal);
      assert.equal(r.tvi.source, 'approved', title.id);
      assert.equal(r.tvi.tvi, title.id === 'cs2' ? 52 : title.workbookTvi, title.id);
    }
    assert.equal(calibrateTitle(t('chess'), cal).tvi.tvi, 8);
  });
  test('ranked base is the reciprocal of the seed; TVI 50 leaves it unchanged', () => {
    const r = calibrateTitle(t('val'), cal);
    assert.equal(r.tvi.source, 'approved');
    assert.equal(r.tvi.tvi, 50);
    r.weights.forEach((w, i) => assert.ok(Math.abs(w - 1 / t('val').entries[i].seed) < 1e-12));
  });
  test('CS2 uses its approved TVI and is marked approved', () => {
    const r = calibrateTitle(t('cs2'), cal);
    assert.equal(r.tvi.source, 'approved');
    assert.equal(r.tvi.tvi, 52);
    const e = t('cs2').entries[0];
    assert.equal(r.weights[0], Math.pow(1 / e.seed, 50 / 52));
  });
  test('session TVI override is flagged as a session value', () => {
    assert.equal(calibrateTitle(t('cs2'), cal, { tvi: 30 }).tvi.source, 'session');
    assert.equal(calibrateTitle(t('cs2'), cal, { tvi: 52 }).tvi.source, 'approved');
  });
  test('method E and Random give equal weights that temperature cannot change', () => {
    for (const r of [calibrateTitle(t('cotw'), cal, { tvi: 5 }), calibrateTitle(t('chess'), cal, { method: 'random', tvi: 90 })]) {
      assert.ok(r.flat);
      assert.ok(r.weights.every(w => w === 1));
    }
  });
  test('SF6 tier-only players take the midpoint of their tier band', () => {
    assert.deepEqual(tierBandSeeds(t('sf6').entries), { Medium: 23 });
  });
  test('method D uses the title\'s own tier table', () => {
    assert.deepEqual(t('pubg').tierTable, { High: 2, Medium: 1, Low: 0.4 });
    const high = t('pubg').entries.findIndex(e => e.cohort === 'High');
    assert.equal(calibrateTitle(t('pubg'), cal).bases[high].base, 2);
  });
});

describe('engine boundaries', () => {
  test('engine source holds no seed, tier, TVI or ladder logic', () => {
    const src = readFileSync(new URL('../js/engine.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    for (const word of ['tvi', 'temperature', 'cohort', 'seed', 'span', 'Math.pow', '7.5', 'calibration']) {
      assert.ok(!src.toLowerCase().includes(word.toLowerCase()), `engine.js mentions "${word}"`);
    }
  });
  test('engine rejects missing or non-positive weights instead of assuming one', () => {
    const bad = w => () => compileModel({ clubs: ['A'], rules: RULES, titles: [{ id: 't', fieldSize: 1, curve: PLAYOFF, entries: [{ club: 0, weight: w }] }] });
    for (const w of [undefined, null, 0, -1, NaN, Infinity]) assert.throws(bad(w));
  });
  test('Plackett-Luce first pick is proportional to weight', () => {
    const weights = [4, 2, 1, 1];
    const model = compileModel({ clubs: ['A', 'B', 'C', 'D'], rules: RULES,
      titles: [{ id: 't', fieldSize: 4, curve: PLAYOFF, entries: weights.map((w, i) => ({ club: i, weight: w })) }] });
    const st = createRunState(model), rng = createRng(7), N = 40000, first = [0, 0, 0, 0];
    for (let r = 0; r < N; r++) { drawPositions(model.titles[0], rng, st.positions[0], st); first[st.positions[0].indexOf(1)]++; }
    weights.forEach((w, i) => {
      const p = w / 8, sd = Math.sqrt(p * (1 - p) / N);
      assert.ok(Math.abs(first[i] / N - p) < 4 * sd, `entry ${i}: ${first[i] / N} vs ${p}`);
    });
    // Second pick given the first: P(B second | A first) = 2/4.
  });
  test('a dominant weight always wins', () => {
    const model = compileModel({ clubs: ['A', 'B'], rules: RULES,
      titles: [{ id: 't', fieldSize: 2, curve: PLAYOFF, entries: [{ club: 0, weight: 1e300 }, { club: 1, weight: 1e-300 }] }] });
    const res = simulate(model, { runs: 2000, rng: createRng(1) });
    assert.equal(res.entryTier[0][0], 2000);
  });
});

describe('simulation', () => {
  const { input, clubIndex } = buildEngineInput(data);
  const model = compileModel(input);

  test('deterministic with a seeded RNG', () => {
    const a = simulate(model, { runs: 300, rng: createRng(42) });
    const b = simulate(model, { runs: 300, rng: createRng(42) });
    const c = simulate(model, { runs: 300, rng: createRng(43) });
    assert.deepEqual(a.rankHist, b.rankHist);
    assert.deepEqual(a.pointsHist, b.pointsHist);
    assert.notDeepEqual(a.rankHist, c.rankHist);
  });

  test('club-focus placement histogram is consistent with the main table', () => {
    const res = simulate(model, { runs: 1000, rng: createRng(5) });
    for (let c = 0; c < model.nClubs; c++) {
      const buckets = placementBuckets(res, c);
      const summary = clubSummary(res, c, null);
      const sumTo = k => buckets.slice(0, k).reduce((s, b) => s + b.runs, 0) / res.runs;
      assert.equal(buckets.reduce((s, b) => s + b.runs, 0), res.runs);
      assert.ok(Math.abs(sumTo(8) - summary.pTop8) < 1e-12, model.clubs[c]);
      assert.ok(Math.abs(sumTo(3) - summary.pTop3) < 1e-12);
      assert.ok(Math.abs(sumTo(24) - summary.pTop24) < 1e-12);
      assert.ok(Math.abs(buckets[0].p - summary.pWin) < 1e-12);
      const row = rankRow(res, c);
      for (let r = 1; r <= 24; r++) assert.equal(buckets[r - 1].runs, row[r]);
      const route = routeFor(res, c, 0, 7);
      assert.ok(Math.abs(route.p - pRankAtMost(res, c, 8)) < 1e-12);
    }
  });

  test('every run ranks every club exactly once and titles award their full curve', () => {
    const res = simulate(model, { runs: 200, rng: createRng(9) });
    for (let c = 0; c < model.nClubs; c++) {
      assert.equal(rankRow(res, c).reduce((s, n) => s + n, 0), 200);
    }
    // Clubs with a single entry have spiky distributions: only curve values are possible per title.
    const vp = clubIndex.get('Vici Gaming');
    const tiers = res.clubTitleTier.subarray((vp * model.nTitles + data.titles.findIndex(t => t.id === 'dota-2')) * model.maxTiers,
      (vp * model.nTitles + data.titles.findIndex(t => t.id === 'dota-2')) * model.maxTiers + 6);
    assert.equal(tiers.reduce((s, n) => s + n, 0), 200);
  });
});
